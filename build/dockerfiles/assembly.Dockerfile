# Grab content from previously build images
FROM linux-libc-amd64 as linux-libc-content
FROM linux-musl-amd64 as linux-musl-content

FROM registry.access.redhat.com/ubi8/ubi:8.5-200 AS ubi-builder
RUN mkdir -p /mnt/rootfs
RUN yum install --installroot /mnt/rootfs git --releasever 8 --nodocs -y && yum --installroot /mnt/rootfs clean all
RUN rm -rf /mnt/rootfs/var/cache/* /mnt/rootfs/var/log/dnf* /mnt/rootfs/var/log/yum.*

WORKDIR /mnt/rootfs

COPY --from=linux-musl-content --chown=0:0 /checode-linux-musl /mnt/rootfs/checode-linux-musl
COPY --from=linux-libc-content --chown=0:0 /checode-linux-libc /mnt/rootfs/checode-linux-libc
RUN ls -l /mnt
RUN ls -la /mnt/rootfs/

RUN cat /mnt/rootfs/etc/passwd | sed s#root:x.*#root:x:\${USER_ID}:\${GROUP_ID}::\${HOME}:/bin/bash#g > ${HOME}/passwd.template \
    && cat /mnt/rootfs/etc/group | sed s#root:x:0:#root:x:0:0,\${USER_ID}:#g > ${HOME}/group.template
RUN mkdir /mnt/rootfs/projects
RUN for f in "${HOME}" "/mnt/rootfs/etc/passwd" "/mnt/rootfs/etc/group" "/mnt/rootfs/projects" ; do\
           chgrp -R 0 ${f} && \
           chmod -R g+rwX ${f}; \
       done

COPY --chmod=755 /build/scripts/*.sh /mnt/rootfs/

# Create all-in-one image
FROM scratch
COPY --from=ubi-builder /mnt/rootfs/ /
USER 1001
ENTRYPOINT /entrypoint.sh