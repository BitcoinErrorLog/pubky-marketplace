Bitcoin payments for locked digital content follow the Lock Server's durable invoice admission (pubky/locks#72):

- After "Request payment in your wallet", the Shop checks the Lock Server request itself and never sends it again.
- While your Paykit wallet is still being set up, the order shows "Reader wallet setup needed" and keeps checking.
- If the request can't be admitted, the order says why instead of waiting: your wallet can't receive the payment, or the request wasn't ready in time. Nothing is charged.
- A retry after a lost answer reuses the same request instead of creating a second one.

This also works with Lock Servers that predate #72.
