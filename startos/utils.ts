// Matches the daemon's DASHBOARD_PORT default (packages/daemon/src/index.ts)
// so the container's internal listen port and StartOS's exposed interface
// port always agree without needing to pass DASHBOARD_PORT through twice.
export const uiPort = 8787
