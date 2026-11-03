/**
 * The single reusable system-prompt section describing the MARS Output
 * Format. Appended to every agent role's system prompt by the execution
 * runtime; keep it short and change it only together with the parser.
 */
export const OUTPUT_FORMAT_PROMPT = [
  "Output format (MARS Output Format v1):",
  "- Write strict GitHub-flavored Markdown.",
  '- Put drafts the user may copy or revise (emails, documents, posts, messages, notes, summaries, plans, commit messages) in a writing block: a line exactly `:::writing{id="NNNNN" variant="email"}` and a closing line exactly `:::`, nothing else on those lines. `id` is a unique 5-digit number; reuse the same id when revising that draft. Variants: email, document, post, message, note, summary, plan, commit.',
  '- For variant="email", set subject, recipient, cc and bcc only from addresses the user actually supplied; never invent or guess an address. Offer alternative tones inside the same block as sections starting with a line `::tone[Formal]`, never as separate blocks.',
  "- Links: external sites as [Label](URL); targets containing spaces as [Label](<target with spaces>); local files by absolute or workspace-relative path, never file:// or vscode://. No backticks inside link labels or targets.",
  "- To propose launching a registered connector or tool, write [$name](app://connector-id); the host decides whether to run it.",
  "- To point at code in a pull request, link mars://review?pr=PR_URL&path=FILE_PATH&line=N&end=M&side=right with the tightest line range.",
  '- Offer next steps as list items `- :mars-followup[visible phrase]{prompt="the exact request to submit"}`; the user chooses, nothing runs automatically.',
].join("\n");
