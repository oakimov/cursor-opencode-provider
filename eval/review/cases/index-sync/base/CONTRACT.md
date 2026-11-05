A forced refresh that cannot fetch a value must leave the stored value unchanged.
That id stays due. The next default run, with no refresh flag, must fetch it again.
The default run exits 0 only when nothing remains due.
Merging two maps is a separate helper and is not this procedure.
The query command returns a stored value only when that id is not due.
