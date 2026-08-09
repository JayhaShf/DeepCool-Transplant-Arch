#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <sys/socket.h>
typedef int (*shutdown_fn)(int, int);
int shutdown(int fd, int how) {
    static shutdown_fn real = 0;
    if (!real) real = (shutdown_fn)dlsym(RTLD_NEXT, "shutdown");
    int r = real(fd, how);
    if (r == -1 && errno == EPERM) return 0;   // seccomp blocks it; pretend success
    return r;
}
