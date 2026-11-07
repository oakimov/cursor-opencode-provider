# Row export

`export_rows(rows, dest)` serializes each row as one JSON line into a private
staging directory, then moves the finished file to `dest`.

The staging directory and anything writing into it belong to `export_rows`
until it returns. `export_rows` returns only after nothing it started can still
write, on success and on failure, and it removes the staging directory after
that point. A row that cannot be serialized (for example, NaN) raises
ValueError; `dest` is then left unchanged.

`export_rows` is called many times by one long-running service. The service
handles SIGINT and SIGTERM itself, without raising them into `export_rows`.
