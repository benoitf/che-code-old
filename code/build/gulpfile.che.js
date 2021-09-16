/**********************************************************************
 * Copyright (c) 2021 Red Hat, Inc.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 ***********************************************************************/
/* eslint-disable header/header */

'use strict';

const gulp = require('gulp');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const path = require('path');
const es = require('event-stream');
const vfs = require('vinyl-fs');
const rename = require('gulp-rename');
const replace = require('gulp-replace');
const filter = require('gulp-filter');
const _ = require('underscore');
const util = require('./lib/util');
const task = require('./lib/task');
const buildfile = require('../src/buildfile');
const common = require('./lib/optimize');
const root = path.dirname(__dirname);
const commit = util.getVersion(root);
const packageJson = require('../package.json');
const product = require('../product.json');
const crypto = require('crypto');
const i18n = require('./lib/i18n');
const { getProductionDependencies } = require('./lib/dependencies');
const { config } = require('./lib/electron');
const createAsar = require('./lib/asar').createAsar;
const minimist = require('minimist');
const { compileBuildTask } = require('./gulpfile.compile');
const { compileExtensionsBuildTask } = require('./gulpfile.extensions');

const cheAssemblyDir = 'out-assembly/checode';
// intermediate files used for the final assembly
const optimizedBuildDir = 'out-tmp-build-optimized';

// Build
const vscodeEntryPoints = _.flatten([
	// use web workbench instead of desktop workbench
	// buildfile.entrypoint('vs/workbench/workbench.desktop.main'),
	buildfile.entrypoint('vs/workbench/workbench.web.api'),
	buildfile.base,
	buildfile.workerExtensionHost,
	buildfile.workerNotebook,
	// web instead of desktop
	// buildfile.workbenchDesktop,
	buildfile.workbenchWeb,
	// che entrypoint and its dependencies
	buildfile.entrypoint('vs/che/node/entrypoint'),
	buildfile.entrypoint('vs/workbench/services/extensions/node/extensionHostProcess'),

	// Add also keyboardMaps as we try to load them
	// for example it tries to load 'out/vs/workbench/services/keybinding/browser/keyboardLayouts/layout.contribution.darwin.js'
	buildfile.keyboardMaps,


]);

const vscodeResources = [
	// 'out-build/main.js',
	// 'out-build/cli.js',
	// 'out-build/driver.js',
	'out-build/bootstrap.js',
	'out-build/bootstrap-fork.js',
	'out-build/bootstrap-amd.js',
	'out-build/bootstrap-node.js',
	// 'out-build/bootstrap-window.js',
	'out-build/vs/**/*.{svg,png,html,jpg}',
	// webPackage path
	'out-build/vs/webPackagePaths.js',

	// keep the html files
	//'!out-build/vs/code/browser/**/*.html',
	'out-build/vs/code/browser/**/*.html',

	'!out-build/vs/editor/standalone/**/*.svg',
	'out-build/vs/base/common/performance.js',
	'out-build/vs/base/node/languagePacks.js',
	'out-build/vs/base/node/{stdForkStart.js,terminateProcess.sh,cpuUsage.sh,ps.sh}',
	'out-build/vs/base/node/userDataPath.js',
	'out-build/vs/base/browser/ui/codicons/codicon/**',
	// 'out-build/vs/base/parts/sandbox/electron-browser/preload.js',
	'out-build/vs/workbench/browser/media/*-theme.css',
	'out-build/vs/workbench/contrib/debug/**/*.json',
	'out-build/vs/workbench/contrib/externalTerminal/**/*.scpt',
	'out-build/vs/workbench/contrib/webview/browser/pre/*.js',
	// 'out-build/vs/workbench/contrib/webview/electron-browser/pre/*.js',
	'out-build/vs/workbench/services/extensions/worker/extensionHostWorkerMain.js',
	'out-build/vs/**/markdown.css',
	'out-build/vs/workbench/contrib/tasks/**/*.json',
	// 'out-build/vs/platform/files/**/*.exe',
	'out-build/vs/platform/files/**/*.md',
	// opt out everything that is electron
	'!out-build/**/{electron-browser,electron-sandbox,electron-main}/**',
	// opt out all tests
	'!**/test/**',

	// add che loader + uri transformer that are .js files and not .ts
	'out-build/vs/che/node/entrypoint-loader.js',
	'out-build/vs/che/node/che-uri-transformer.js',


];
const optimizedMinBuildDir = `${optimizedBuildDir}-min`;

const optimizeVSCodeTask = task.define('optimize-che', task.series(
	util.rimraf(optimizedBuildDir),
	common.optimizeTask({
		src: 'out-build',
		entryPoints: vscodeEntryPoints,
		resources: vscodeResources,
		loaderConfig: common.loaderConfig(),
		out: optimizedBuildDir,
		bundleInfo: undefined
	})
));
gulp.task(optimizeVSCodeTask);

// do not upload sourcemaps there
// const sourceMappingURLBase = `https://ticino.blob.core.windows.net/sourcemaps/${commit}`;
const minifyVSCodeTask = task.define('minify-che', task.series(
	optimizeVSCodeTask,
	util.rimraf(optimizedMinBuildDir),
	common.minifyTask(optimizedBuildDir/*, `${sourceMappingURLBase}/core`*/)
));
gulp.task(minifyVSCodeTask);

/*
const core = task.define('core-ci', task.series(
	gulp.task('compile-build'),
	task.parallel(
		gulp.task('minify-vscode'),
		gulp.task('minify-vscode-reh'),
		gulp.task('minify-vscode-reh-web'),
	)
));
gulp.task(core);
*/

/**
 * Compute checksums for some files.
 *
 * @param {string} out The out folder to read the file from.
 * @param {string[]} filenames The paths to compute a checksum for.
 * @return {Object} A map of paths to checksums.
 */
function computeChecksums(out, filenames) {
	let result = {};
	filenames.forEach(function (filename) {
		let fullPath = path.join(process.cwd(), out, filename);
		result[filename] = computeChecksum(fullPath);
	});
	return result;
}

/**
 * Compute checksum for a file.
 *
 * @param {string} filename The absolute path to a filename.
 * @return {string} The checksum for `filename`.
 */
function computeChecksum(filename) {
	let contents = fs.readFileSync(filename);

	let hash = crypto
		.createHash('md5')
		.update(contents)
		.digest('base64')
		.replace(/=+$/, '');

	return hash;
}

function packageTask(platform, arch, sourceFolderName, destinationFolderName, opts) {
	opts = opts || {};

	// do not generate folder in an upper level
	//const destination = path.join(path.dirname(root), destinationFolderName);
	const destination = destinationFolderName;

	platform = platform || process.platform;

	return () => {
		// const electron = require('gulp-atom-electron');
		const json = require('gulp-json-editor');

		const out = sourceFolderName;

		const checksums = computeChecksums(out, [
			// remove electron stuff
			// 'vs/base/parts/sandbox/electron-browser/preload.js',
			'vs/workbench/workbench.web.api.js',
			'vs/workbench/workbench.web.api.css',
			'vs/workbench/services/extensions/node/extensionHostProcess.js',
			// 'vs/code/electron-browser/workbench/workbench.html',
			// 'vs/code/electron-browser/workbench/workbench.js'
		]);

		const src = gulp.src(out + '/**', { base: '.' })
			.pipe(rename(function (path) { path.dirname = path.dirname.replace(new RegExp('^' + out), 'out'); }))
			.pipe(util.setExecutableBit(['**/*.sh']));

		const platformSpecificBuiltInExtensionsExclusions = product.builtInExtensions.filter(ext => {
			if (!ext.platforms) {
				return false;
			}

			const set = new Set(ext.platforms);
			return !set.has(platform);
		}).map(ext => `!.build/extensions/${ext.name}/**`);

		const extensions = gulp.src(['.build/extensions/**', ...platformSpecificBuiltInExtensionsExclusions], { base: '.build', dot: true });

		const sources = es.merge(src, extensions)
			.pipe(filter(['**',
				// keep the map files
				// '!**/*.js.map'
			], { dot: true }));

		let version = packageJson.version;
		const quality = product.quality;

		if (quality && quality !== 'stable') {
			version += '-' + quality;
		}

		const name = product.nameShort;
		const packageJsonUpdates = { name, version };

		// for linux url handling
		if (platform === 'linux') {
			packageJsonUpdates.desktopName = `${product.applicationName}-url-handler.desktop`;
		}

		const packageJsonStream = gulp.src(['package.json'], { base: '.' })
			.pipe(json(packageJsonUpdates));

		const date = new Date().toISOString();
		const productJsonUpdate = { commit, date, checksums };

		// for azure CI
		/*if (shouldSetupSettingsSearch()) {
			productJsonUpdate.settingsSearchBuildId = getSettingsSearchBuildId(packageJson);
		}*/

		const productJsonStream = gulp.src(['product.json'], { base: '.' })
			.pipe(json(productJsonUpdate));

		const license = gulp.src(['LICENSES.chromium.html', product.licenseFileName, 'ThirdPartyNotices.txt', 'licenses/**'], { base: '.', allowEmpty: true });

		// docker files
		const dockerfiles = gulp.src(['Dockerfile', 'entrypoint.sh'], { base: '.', allowEmpty: true });


		// TODO the API should be copied to `out` during compile, not here
		const api = gulp.src('src/vs/vscode.d.ts').pipe(rename('out/vs/vscode.d.ts'));

		// do not have telemetry files there
		// const telemetry = gulp.src('.build/telemetry/**', { base: '.build/telemetry', dot: true });

		// const jsFilter = util.filter(data => !data.isDirectory() && /\.js$/.test(data.path));
		const root = path.resolve(path.join(__dirname, '..'));
		const productionDependencies = getProductionDependencies(root);
		const dependenciesSrc = _.flatten(productionDependencies.map(d => path.relative(root, d.path)).map(d => [`${d}/**`, `!${d}/**/{test,tests}/**`]));

		const deps = gulp.src(dependenciesSrc, { base: '.', dot: true })
			.pipe(filter(['**', `!**/${config.version}/**`, '!**/bin/darwin-arm64-85/**', '!**/package-lock.json', '!**/yarn.lock', '!**/*.js.map']))
			.pipe(util.cleanNodeModules(path.join(__dirname, '.moduleignore')));
		// do not create asar archive as it's for electron
		// .pipe(jsFilter)
		// /* Disable as we're not rewriting URLs .pipe(util.rewriteSourceMappingURL(sourceMappingURLBase))*/
		// .pipe(jsFilter.restore)
		// .pipe(createAsar(path.join(process.cwd(), 'node_modules'), ['**/*.node', '**/vscode-ripgrep/bin/*', '**/node-pty/build/Release/*', '**/*.wasm'], 'node_modules.asar'));

		let all = es.merge(
			packageJsonStream,
			productJsonStream,
			license,
			dockerfiles,
			api,
			// telemetry,
			sources,
			deps
		);

		if (platform === 'win32') {
			all = es.merge(all, gulp.src([
				'resources/win32/bower.ico',
				'resources/win32/c.ico',
				'resources/win32/config.ico',
				'resources/win32/cpp.ico',
				'resources/win32/csharp.ico',
				'resources/win32/css.ico',
				'resources/win32/default.ico',
				'resources/win32/go.ico',
				'resources/win32/html.ico',
				'resources/win32/jade.ico',
				'resources/win32/java.ico',
				'resources/win32/javascript.ico',
				'resources/win32/json.ico',
				'resources/win32/less.ico',
				'resources/win32/markdown.ico',
				'resources/win32/php.ico',
				'resources/win32/powershell.ico',
				'resources/win32/python.ico',
				'resources/win32/react.ico',
				'resources/win32/ruby.ico',
				'resources/win32/sass.ico',
				'resources/win32/shell.ico',
				'resources/win32/sql.ico',
				'resources/win32/typescript.ico',
				'resources/win32/vue.ico',
				'resources/win32/xml.ico',
				'resources/win32/yaml.ico',
				'resources/win32/code_70x70.png',
				'resources/win32/code_150x150.png'
			], { base: '.' }));
		} else if (platform === 'linux') {
			all = es.merge(all, gulp.src('resources/linux/code.png', { base: '.' }));
		} else if (platform === 'darwin') {
			const shortcut = gulp.src('resources/darwin/bin/code.sh')
				.pipe(rename('bin/code'));

			all = es.merge(all, shortcut);
		}

		let result = all
			.pipe(util.skipDirectories())
			.pipe(util.fixWin32DirectoryPermissions())
			.pipe(filter(['**', '!**/.github/**'], { dot: true })) // https://github.com/microsoft/vscode/issues/116523
			// do not add electron bits in the assembly folde
			/*.pipe(electron(_.extend({}, config, { platform, arch: arch === 'armhf' ? 'arm' : arch, ffmpegChromium: true })))*/
			.pipe(filter(['**', '!LICENSE', '!LICENSES.chromium.html', '!version'], { dot: true }));

		if (platform === 'linux') {
			result = es.merge(result, gulp.src('resources/completions/bash/code', { base: '.' })
				.pipe(replace('@@APPNAME@@', product.applicationName))
				.pipe(rename(function (f) { f.basename = product.applicationName; })));

			result = es.merge(result, gulp.src('resources/completions/zsh/_code', { base: '.' })
				.pipe(replace('@@APPNAME@@', product.applicationName))
				.pipe(rename(function (f) { f.basename = '_' + product.applicationName; })));
		}

		if (platform === 'win32') {
			result = es.merge(result, gulp.src('resources/win32/bin/code.js', { base: 'resources/win32', allowEmpty: true }));

			result = es.merge(result, gulp.src('resources/win32/bin/code.cmd', { base: 'resources/win32' })
				.pipe(replace('@@NAME@@', product.nameShort))
				.pipe(rename(function (f) { f.basename = product.applicationName; })));

			result = es.merge(result, gulp.src('resources/win32/bin/code.sh', { base: 'resources/win32' })
				.pipe(replace('@@NAME@@', product.nameShort))
				.pipe(replace('@@PRODNAME@@', product.nameLong))
				.pipe(replace('@@VERSION@@', version))
				.pipe(replace('@@COMMIT@@', commit))
				.pipe(replace('@@APPNAME@@', product.applicationName))
				.pipe(replace('@@DATAFOLDER@@', product.dataFolderName))
				.pipe(replace('@@QUALITY@@', quality))
				.pipe(rename(function (f) { f.basename = product.applicationName; f.extname = ''; })));

			result = es.merge(result, gulp.src('resources/win32/VisualElementsManifest.xml', { base: 'resources/win32' })
				.pipe(rename(product.nameShort + '.VisualElementsManifest.xml')));
		} else if (platform === 'linux') {
			result = es.merge(result, gulp.src('resources/linux/bin/code.sh', { base: '.' })
				.pipe(replace('@@PRODNAME@@', product.nameLong))
				.pipe(replace('@@NAME@@', product.applicationName))
				.pipe(rename('bin/' + product.applicationName)));
		}

		// submit all stats that have been collected
		// during the build phase
		if (opts.stats) {
			result.on('end', () => {
				const { submitAllStats } = require('./lib/stats');
				submitAllStats(product, commit).then(() => console.log('Submitted bundle stats!'));
			});
		}

		return result.pipe(vfs.dest(destination));
	};
}

const buildRoot = path.dirname(root);

// no build target for che, only one arch for the current arch
/*const BUILD_TARGETS = [
	{ platform: 'win32', arch: 'ia32' },
	{ platform: 'win32', arch: 'x64' },
	{ platform: 'win32', arch: 'arm64' },
	{ platform: 'darwin', arch: 'x64', opts: { stats: true } },
	{ platform: 'darwin', arch: 'arm64', opts: { stats: true } },
	{ platform: 'linux', arch: 'ia32' },
	{ platform: 'linux', arch: 'x64' },
	{ platform: 'linux', arch: 'armhf' },
	{ platform: 'linux', arch: 'arm64' },
];
BUILD_TARGETS.forEach(buildTarget => {
	*/
const dashed = (str) => (str ? `-${str}` : ``);
// const platform = buildTarget.platform;
// const arch = buildTarget.arch;
// const opts = buildTarget.opts;

// darwin
let opts = undefined;
if (process.platform === 'darwin') {
	opts = { stats: true };
}

const [vscode, vscodeMin] = ['', 'min'].map(minified => {
	const sourceFolderName = `${optimizedBuildDir}${dashed(minified)}`;
	const destinationFolderName = `${cheAssemblyDir}${dashed(minified)}`;

	const vscodeTaskCI = task.define(`checode${dashed(minified)}-ci`, task.series(
		util.rimraf(path.join(buildRoot, destinationFolderName)),
		packageTask(process.platform, process.arch, sourceFolderName, destinationFolderName, opts)
	));
	gulp.task(vscodeTaskCI);

	const vscodeTask = task.define(`checode${dashed(minified)}`, task.series(
		compileBuildTask,
		compileExtensionsBuildTask,
		minified ? minifyVSCodeTask : optimizeVSCodeTask,
		vscodeTaskCI
	));
	gulp.task(vscodeTask);

	return vscodeTask;
});

gulp.task(vscode);
gulp.task(vscodeMin);

// if (process.platform === platform && process.arch === arch) {
//gulp.task(task.define('che', task.series(vscode)));
//gulp.task(task.define('che-min', task.series(vscodeMin)));
// }
// });

