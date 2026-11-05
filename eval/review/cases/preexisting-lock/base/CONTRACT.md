update keeps its exclusive lock until the mutation returns.
Another process must not be able to take that lock during the mutation.
reserve is one caller of update. The lock covers the mutation reserve performs.
