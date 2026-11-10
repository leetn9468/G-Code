/* Track inherited Seatbelt policies, including fork + setsid + reparenting.
 * No process arguments/environment are read. Only this uid and exact random
 * policy markers are eligible. The negative control excludes broad policies.
 * sandbox_check is macOS SPI (also declared by upstream WebKit SandboxSPI.h);
 * startup performs a real policy round trip and fails closed if it changes. */
#include <errno.h>
#include <libproc.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <unistd.h>

extern int sandbox_check(pid_t, const char *, int, ...);
extern const int SANDBOX_CHECK_NO_REPORT;

static int info(pid_t pid, struct proc_bsdinfo *p) {
    return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, p, sizeof(*p)) == sizeof(*p)
        && p->pbi_uid == getuid() && p->pbi_status != 5; /* SZOMB */
}
static int same(const struct proc_bsdinfo *a, const struct proc_bsdinfo *b) {
    return a->pbi_pid == b->pbi_pid && a->pbi_start_tvsec == b->pbi_start_tvsec
        && a->pbi_start_tvusec == b->pbi_start_tvusec;
}
static int belongs(pid_t pid, const char *marker) {
    if (sandbox_check(pid, NULL, 0) != 1) return 0;
    char negative[160]; snprintf(negative, sizeof(negative), "%s.absent", marker);
    return sandbox_check(pid, "mach-lookup", 2 | SANDBOX_CHECK_NO_REPORT, marker) == 0
        && sandbox_check(pid, "mach-lookup", 2 | SANDBOX_CHECK_NO_REPORT, negative) == 1;
}
static int valid(const char *tag) {
    if (strncmp(tag, "GCODE_GUARD_", 12) || strlen(tag) != 44) return 0;
    for (const char *c = tag + 12; *c; c++) if (!strchr("0123456789abcdef", *c)) return 0;
    return 1;
}
int main(int argc, char **argv) {
    if (argc < 2 || (strcmp(argv[1], "list") && strcmp(argv[1], "stop")) || argc > 4098) return 64;
    const int stop = !strcmp(argv[1], "stop"), count = argc - 2;
    char (*markers)[160] = calloc(count ? count : 1, 160);
    if (!markers) return 70;
    for (int n = 0; n < count; n++) {
        if (!valid(argv[n + 2])) { free(markers); return 64; }
        snprintf(markers[n], 160, "com.gcode.guard.%s", argv[n + 2]);
    }
    // Stop before kill, then rescan: a child racing the first enumeration
    // inherits the marker. Bounded failure never claims cleanup succeeded.
    for (int pass = 0; pass < (stop ? 64 : 1); pass++) {
        int capacity = proc_listallpids(NULL, 0) + 4096;
        if (capacity <= 4096 || capacity > 1048576) { free(markers); return 71; }
        pid_t *pids = calloc(capacity, sizeof(pid_t));
        if (!pids) { free(markers); return 70; }
        int length = proc_listallpids(pids, capacity * sizeof(pid_t)), found = 0;
        if (length <= 0 || length >= capacity) { free(pids); free(markers); return 71; }
        for (int i = 0; i < length; i++) {
            struct proc_bsdinfo before, after;
            if (pids[i] <= 1 || pids[i] == getpid() || !info(pids[i], &before)) continue;
            for (int n = 0; n < count; n++) {
                if (!belongs(pids[i], markers[n]) || !info(pids[i], &after) || !same(&before, &after)) continue;
                found++;
                printf("%d\t%d\t%u\t%u\t%llu:%llu\n", n, pids[i], after.pbi_ppid, after.pbi_pgid,
                    after.pbi_start_tvsec, after.pbi_start_tvusec);
                if (stop) {
                    if (kill(pids[i], SIGSTOP) && errno != ESRCH) { free(pids); free(markers); return 72; }
                    if (info(pids[i], &after) && same(&before, &after) && belongs(pids[i], markers[n])) {
                        if (kill(pids[i], SIGKILL) && errno != ESRCH) { free(pids); free(markers); return 72; }
                    }
                }
                break;
            }
        }
        free(pids);
        if (!stop || !found) { free(markers); return 0; }
        usleep(10000);
    }
    free(markers);
    return 73;
}
