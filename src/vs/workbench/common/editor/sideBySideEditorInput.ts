/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from 'vs/base/common/event';
import { URI } from 'vs/base/common/uri';
import { localize } from 'vs/nls';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { Registry } from 'vs/platform/registry/common/platform';
import { IEditorInput, EditorInputCapabilities, GroupIdentifier, ISaveOptions, IRevertOptions, EditorExtensions, IEditorFactoryRegistry, IEditorSerializer, ISideBySideEditorInput, IUntypedEditorInput, isResourceSideBySideEditorInput, isDiffEditorInput, isResourceDiffEditorInput, IResourceSideBySideEditorInput, findViewStateForEditor, IMoveResult, isEditorInput, isResourceEditorInput, Verbosity } from 'vs/workbench/common/editor';
import { DiffEditorInput } from 'vs/workbench/common/editor/diffEditorInput';
import { EditorInput } from 'vs/workbench/common/editor/editorInput';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';

/**
 * Side by side editor inputs that have a primary and secondary side.
 */
export class SideBySideEditorInput extends EditorInput implements ISideBySideEditorInput {

	static readonly ID: string = 'workbench.editorinputs.sidebysideEditorInput';

	override get typeId(): string {
		return SideBySideEditorInput.ID;
	}

	override get capabilities(): EditorInputCapabilities {

		// Use primary capabilities as main capabilities...
		let capabilities = this.primary.capabilities;

		// ...with the exception of `CanSplitInGroup` which
		// is only relevant to single editors.
		capabilities &= ~EditorInputCapabilities.CanSplitInGroup;

		// Trust: should be considered for both sides
		if (this.secondary.hasCapability(EditorInputCapabilities.RequiresTrust)) {
			capabilities |= EditorInputCapabilities.RequiresTrust;
		}

		// Singleton: should be considered for both sides
		if (this.secondary.hasCapability(EditorInputCapabilities.Singleton)) {
			capabilities |= EditorInputCapabilities.Singleton;
		}

		return capabilities;
	}

	get resource(): URI | undefined {
		if (this.hasIdenticalSides) {
			// pretend to be just primary side when being asked for a resource
			// in case both sides are the same. this can help when components
			// want to identify this input among others (e.g. in history).
			return this.primary.resource;
		}

		return undefined;
	}

	private hasIdenticalSides = this.primary.matches(this.secondary);

	constructor(
		protected readonly name: string | undefined,
		protected readonly description: string | undefined,
		readonly secondary: IEditorInput,
		readonly primary: IEditorInput,
		@IEditorService private readonly editorService: IEditorService
	) {
		super();

		this.registerListeners();
	}

	private registerListeners(): void {

		// When the primary or secondary input gets disposed, dispose this diff editor input
		this._register(Event.once(Event.any(this.primary.onWillDispose, this.secondary.onWillDispose))(() => {
			if (!this.isDisposed()) {
				this.dispose();
			}
		}));

		// Re-emit some events from the primary side to the outside
		this._register(this.primary.onDidChangeDirty(() => this._onDidChangeDirty.fire()));
		this._register(this.primary.onDidChangeLabel(() => this._onDidChangeLabel.fire()));

		// Re-emit some events from both sides to the outside
		this._register(this.primary.onDidChangeCapabilities(() => this._onDidChangeCapabilities.fire()));
		this._register(this.secondary.onDidChangeCapabilities(() => this._onDidChangeCapabilities.fire()));
	}

	override getName(): string {
		if (!this.name) {
			if (this.hasIdenticalSides) {
				return this.primary.getName(); // keep name concise when same editor is opened side by side
			}

			return localize('sideBySideLabels', "{0} - {1}", this.secondary.getName(), this.primary.getName());
		}

		return this.name;
	}

	override getLabelExtraClasses(): string[] {
		if (this.hasIdenticalSides) {
			return this.primary.getLabelExtraClasses();
		}

		return super.getLabelExtraClasses();
	}

	override getDescription(verbosity?: Verbosity): string | undefined {
		if (this.hasIdenticalSides) {
			return this.primary.getDescription(verbosity);
		}

		return this.description;
	}

	override getTitle(verbosity?: Verbosity): string {
		if (this.hasIdenticalSides) {
			return this.primary.getTitle(verbosity) ?? this.getName();
		}

		return super.getTitle(verbosity);
	}

	override getAriaLabel(): string {
		if (this.hasIdenticalSides) {
			return this.primary.getAriaLabel();
		}

		return super.getAriaLabel();
	}

	override getTelemetryDescriptor(): { [key: string]: unknown } {
		const descriptor = this.primary.getTelemetryDescriptor();

		return { ...descriptor, ...super.getTelemetryDescriptor() };
	}

	override isDirty(): boolean {
		return this.primary.isDirty();
	}

	override isSaving(): boolean {
		return this.primary.isSaving();
	}

	override async save(group: GroupIdentifier, options?: ISaveOptions): Promise<IEditorInput | undefined> {
		const editor = await this.primary.save(group, options);
		if (!editor || !this.hasIdenticalSides) {
			return editor;
		}

		return new SideBySideEditorInput(this.name, this.description, editor, editor, this.editorService);
	}

	override async saveAs(group: GroupIdentifier, options?: ISaveOptions): Promise<IEditorInput | undefined> {
		const editor = await this.primary.saveAs(group, options);
		if (!editor || !this.hasIdenticalSides) {
			return editor;
		}

		return new SideBySideEditorInput(this.name, this.description, editor, editor, this.editorService);
	}

	override revert(group: GroupIdentifier, options?: IRevertOptions): Promise<void> {
		return this.primary.revert(group, options);
	}

	override async rename(group: GroupIdentifier, target: URI): Promise<IMoveResult | undefined> {
		if (!this.hasIdenticalSides) {
			return; // currently only enabled when both sides are identical
		}

		// Forward rename to primary side
		const renameResult = await this.primary.rename(group, target);
		if (!renameResult) {
			return undefined;
		}

		// Build a side-by-side result from the rename result

		if (isEditorInput(renameResult.editor)) {
			return {
				editor: new SideBySideEditorInput(this.name, this.description, renameResult.editor, renameResult.editor, this.editorService),
				options: {
					...renameResult.options,
					viewState: findViewStateForEditor(this, group, this.editorService)
				}
			};
		}

		if (isResourceEditorInput(renameResult.editor)) {
			return {
				editor: {
					label: this.name,
					description: this.description,
					primary: renameResult.editor,
					secondary: renameResult.editor,
					options: {
						...renameResult.options,
						viewState: findViewStateForEditor(this, group, this.editorService)
					}
				}
			};
		}

		return undefined;
	}

	override toUntyped(options?: { preserveViewState: GroupIdentifier }): IResourceSideBySideEditorInput | undefined {
		const primaryResourceEditorInput = this.primary.toUntyped(options);
		const secondaryResourceEditorInput = this.secondary.toUntyped(options);

		// Prevent nested side by side editors which are unsupported
		if (
			primaryResourceEditorInput && secondaryResourceEditorInput &&
			!isResourceDiffEditorInput(primaryResourceEditorInput) && !isResourceDiffEditorInput(secondaryResourceEditorInput) &&
			!isResourceSideBySideEditorInput(primaryResourceEditorInput) && !isResourceSideBySideEditorInput(secondaryResourceEditorInput)
		) {
			const untypedInput: IResourceSideBySideEditorInput = {
				label: this.name,
				description: this.description,
				primary: primaryResourceEditorInput,
				secondary: secondaryResourceEditorInput
			};

			if (typeof options?.preserveViewState === 'number') {
				untypedInput.options = {
					viewState: findViewStateForEditor(this, options.preserveViewState, this.editorService)
				};
			}

			return untypedInput;
		}

		return undefined;
	}

	override matches(otherInput: IEditorInput | IUntypedEditorInput): boolean {
		if (this === otherInput) {
			return true;
		}

		if (isDiffEditorInput(otherInput) || isResourceDiffEditorInput(otherInput)) {
			return false; // prevent subclass from matching
		}

		if (otherInput instanceof SideBySideEditorInput) {
			return this.primary.matches(otherInput.primary) && this.secondary.matches(otherInput.secondary);
		}

		if (isResourceSideBySideEditorInput(otherInput)) {
			return this.primary.matches(otherInput.primary) && this.secondary.matches(otherInput.secondary);
		}

		return false;
	}
}

// Register SideBySide/DiffEditor Input Serializer
interface ISerializedSideBySideEditorInput {
	name: string;
	description: string | undefined;

	primarySerialized: string;
	secondarySerialized: string;

	primaryTypeId: string;
	secondaryTypeId: string;
}

export abstract class AbstractSideBySideEditorInputSerializer implements IEditorSerializer {

	canSerialize(editorInput: EditorInput): boolean {
		const input = editorInput as SideBySideEditorInput | DiffEditorInput;

		if (input.primary && input.secondary) {
			const [secondaryInputSerializer, primaryInputSerializer] = this.getSerializers(input.secondary.typeId, input.primary.typeId);

			return !!(secondaryInputSerializer?.canSerialize(input.secondary) && primaryInputSerializer?.canSerialize(input.primary));
		}

		return false;
	}

	serialize(editorInput: EditorInput): string | undefined {
		const input = editorInput as SideBySideEditorInput;

		if (input.primary && input.secondary) {
			const [secondaryInputSerializer, primaryInputSerializer] = this.getSerializers(input.secondary.typeId, input.primary.typeId);
			if (primaryInputSerializer && secondaryInputSerializer) {
				const primarySerialized = primaryInputSerializer.serialize(input.primary);
				const secondarySerialized = secondaryInputSerializer.serialize(input.secondary);

				if (primarySerialized && secondarySerialized) {
					const serializedEditorInput: ISerializedSideBySideEditorInput = {
						name: input.getName(),
						description: input.getDescription(),
						primarySerialized: primarySerialized,
						secondarySerialized: secondarySerialized,
						primaryTypeId: input.primary.typeId,
						secondaryTypeId: input.secondary.typeId
					};

					return JSON.stringify(serializedEditorInput);
				}
			}
		}

		return undefined;
	}

	deserialize(instantiationService: IInstantiationService, serializedEditorInput: string): EditorInput | undefined {
		const deserialized: ISerializedSideBySideEditorInput = JSON.parse(serializedEditorInput);

		const [secondaryInputSerializer, primaryInputSerializer] = this.getSerializers(deserialized.secondaryTypeId, deserialized.primaryTypeId);
		if (primaryInputSerializer && secondaryInputSerializer) {
			const primaryInput = primaryInputSerializer.deserialize(instantiationService, deserialized.primarySerialized);
			const secondaryInput = secondaryInputSerializer.deserialize(instantiationService, deserialized.secondarySerialized);

			if (primaryInput instanceof EditorInput && secondaryInput instanceof EditorInput) {
				return this.createEditorInput(instantiationService, deserialized.name, deserialized.description, secondaryInput, primaryInput);
			}
		}

		return undefined;
	}

	private getSerializers(secondaryEditorInputTypeId: string, primaryEditorInputTypeId: string): [IEditorSerializer | undefined, IEditorSerializer | undefined] {
		const registry = Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory);

		return [registry.getEditorSerializer(secondaryEditorInputTypeId), registry.getEditorSerializer(primaryEditorInputTypeId)];
	}

	protected abstract createEditorInput(instantiationService: IInstantiationService, name: string, description: string | undefined, secondaryInput: EditorInput, primaryInput: EditorInput): EditorInput;
}

export class SideBySideEditorInputSerializer extends AbstractSideBySideEditorInputSerializer {

	protected createEditorInput(instantiationService: IInstantiationService, name: string, description: string | undefined, secondaryInput: EditorInput, primaryInput: EditorInput): EditorInput {
		return instantiationService.createInstance(SideBySideEditorInput, name, description, secondaryInput, primaryInput);
	}
}
