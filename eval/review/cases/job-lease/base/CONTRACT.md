A cancel command received before the worker finishes must stop that worker.
The supervisor must not write a success receipt for a cancelled attempt.
The worker's own exit status, after it was cancelled, is not a success.
