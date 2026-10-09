Bitcoin payment problems now say what happened and what to do next, in plain words:

- A payment request that takes too long shows "Still waiting on the payment request" with a Check again button, instead of an endless spinner.
- A request that wasn't ready in time no longer says nothing was charged. It tells you not to pay any request for that order that reached your wallet, then to check out again.
- A request your wallet declined, canceled, let expire, or that ran out of payment time now says so, and what to do next.
- A request the Paykit server couldn't create, or that conflicted with an earlier one, is named as such.
- When Bitcoin can't start at checkout, the message no longer blames "the Paykit server": it tells you to try again or pick another payment method.

This reads the fields Lock Servers v0.1.0-rc9 and later add (pubky/locks `admission_deadline_at` and the four invoice-admission failure messages) and works unchanged with older Lock Servers.
