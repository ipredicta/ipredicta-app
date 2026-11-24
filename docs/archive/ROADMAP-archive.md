# ROADMAP archive (app)

Items moved out of ROADMAP.md on 24 Nov 2026 after the 23 Nov 2026 triage (~/ipredicta-handoff/triage-1123/triage.md): done, duplicate or obsolete. Each item starts with one line saying why it was archived; the text under that line is the item exactly as it stood in ROADMAP.md. Item numbers are unchanged, so a reference such as "#508" still finds its item here.

> Archived 24 Nov 2026: Reflection on CMP trigger, not actionable.

### The point at which a hand-written mechanism stops being the right answer

The site's ROADMAP carries a CMP crossover trigger: conditions about the number of
categories and the number of vendors, past which a hand-rolled consent mechanism costs more
than a bought one. **This change adds a second property to that calculation**, and the
trigger was written when there was one.

Two implementations of the same policy, in two repositories, sharing a cookie and a version
constant that nothing compares, is exactly the shape the trigger exists to catch. Read the
site's entry before adding a category to either, and treat "a second origin" as worth a
condition of its own.
