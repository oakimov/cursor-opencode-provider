run attempts every id that is due, in order.
A fetch failure leaves that id due and returns 1.
A later run attempts the ids that are still due. That later run is the retry.
