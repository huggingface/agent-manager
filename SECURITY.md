# Security

## The trust model, in one sentence

Agent Manager has **no authentication of its own**. It gives whoever can reach
it a shell and control of your logged-in AI agents. Its only access control is
the privacy of the Hugging Face Space it runs on.

**Keep the Space private, and keep its storage bucket private.** A public Space
hands anyone a terminal; a public bucket exposes everything the agents saved,
including credentials.

The app defends this itself: it checks its own visibility on a timer and, if it
finds the Space (or a mounted bucket it can verify) is public, it locks down,
refuses WebSocket connections, hides secret names, and shows a setup page
instead of terminals. If you have not set an `HF_TOKEN`, the app cannot discover
which bucket is mounted and so cannot verify the bucket's visibility on its own
in that case it warns rather than locking, so double-check your bucket is
private.

## Good practice for self-hosters

- Duplicate the Space as **Private** and mount a **Private** bucket at `/data`.
- Store provider API keys as **Space secrets**, not in the repo.
- Do not paste the Space's direct `*.hf.space` URL where others can reach it.

## Reporting a vulnerability

Please report security issues privately via GitHub Security Advisories
("Report a vulnerability" on the repository's Security tab) rather than opening a
public issue. We'll respond as quickly as we can.
