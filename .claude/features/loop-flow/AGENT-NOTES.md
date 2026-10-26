# Read this before working on any ticket

This is low-stakes personal plugin work. The user asked for speed over review ceremony:

- **No review cycles per ticket.** Don't run the code-review skill, don't spawn reviewer agents, and don't run review-and-fix loops. One review of the whole change happens at the end, after every ticket is done.
- **Don't run skills end to end to try them out** (code-review, apply-review, narrative). Check prompt and skill edits by reading them and with unit tests on the parsers.
- **Keep tests to the essentials:** the loop reducer's behaviour, plus one or two adapter tests per new path. Don't write exhaustive tables.
- **Docs:** a line or two in the README where behaviour changes. No rewrites.
- **Aim to finish a ticket in about 20–30 minutes.** If something outside the ticket blocks you, note it in your report and move on.
