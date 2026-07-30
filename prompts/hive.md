---
description: Deep multi-model reasoning — decompose to first principles, vote on what is real, propose solutions, vote again
---
Use the hive_think tool to analyze the following question or problem:

$@

**When calling hive_think:**
- Pass the complete question as the `question` parameter
- Put everything the nodes need into `context`: conversation background, constraints, relevant code, what has already been tried, and your current thinking. The nodes can read and grep for what you missed, but not for constraints that were never written down.
- The hive decomposes the question to first-principles claims, votes on which are real, proposes solutions, then votes on those

**When reading the result:**
- Read the vote counts, not just the pass marks — with at most ten ballots the effective threshold drifts from the nominal one
- An item that passed on few voters is weak even at 100%
- An unresolved alternatives group means the hive found no majority; break the tie yourself and say why
- You make the final call — the hive narrows and stress-tests the options
