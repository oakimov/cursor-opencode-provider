# Check runner

`run_checks(source, commands)` copies `source` into a new private workspace and
runs each command there, in order. It stops at the first command that exits
nonzero and returns that status, or 0 when every command passed.

The runner owns every process a command starts, including the processes those
start, from the moment the command starts until `run_checks` returns. A command
runs in a process group of its own, and its processes stay in that group; a
process that moves itself to another group or session has left the runner's
ownership and is outside this contract. When
`run_checks` returns, for any reason, none of those processes is still running,
and the workspace has been removed. The workspace is removed only after no owned
process can still write to it.

The command line is `runner.py --source DIR --command JSON [--command JSON ...]`,
where each JSON value is an argument list. SIGINT or SIGTERM to the runner stops
the running command and every process it started, removes the workspace, and
exits with 130 or 143 respectively. A runner killed with SIGKILL cannot clean up.
