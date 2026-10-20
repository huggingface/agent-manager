# Security

## The trust model, in one sentence

Agent Manager has **no authentication of its own**. It gives whoever can reach
it a shell and control of your logged-in AI agents. Its only access control is
the privacy of the Hugging Face Space it runs on.

**Keep the Space private, and keep its storage bucket private.** A public Space
hands anyone a terminal; a public bucket exposes everything the agents saved,
including credentials.

The app defends this itself with a privacy lock (details in
[docs/privacy-lock.md](docs/privacy-lock.md)): it verifies the Space and every
mounted bucket against the Hub once a minute and serves its privileged API only
while that evidence is fresh. A Space or bucket seen to be public locks it at
once; a check that has not succeeded for 2.5 minutes locks it too, as an outage
rather than as proof of exposure. Locking refuses new requests and terminal
attachments **and** revokes connections that were already open — terminals,
long polls, remote agents' streams — on the server, whether or not a browser
is watching; agents keep running, and the app reopens by itself once a check
succeeds. While locked it serves only health, a public-safe status and the
setup page, and hides secret names. If you have not set an `HF_TOKEN`, the app
cannot discover which bucket is mounted and so cannot verify the bucket's
visibility on its own; in that case it warns rather than locking, so
double-check your bucket is private. Locking does not make a public bucket
private and cannot take back anything delivered before the lock.

## Good practice for self-hosters

- Duplicate the Space as **Private** and mount a **Private** bucket at `/data`.
- Store provider API keys as **Space secrets**, not in the repo.
- Do not paste the Space's direct `*.hf.space` URL where others can reach it.

## Reporting a vulnerability

Please report security issues privately via GitHub Security Advisories
("Report a vulnerability" on the repository's Security tab) rather than opening a
public issue. We'll respond as quickly as we can.
