# Résumé-first profile

Saving a planning budget or search preferences first still opens résumé onboarding. Completing the wizard records the explicit profile confirmation.

Open **Profile**, then choose a PDF, DOCX or TXT résumé or paste the text. Review the text before continuing. An empty source also works for manual entry.

1. **Start with your résumé.** The native picker reads one selected file locally. A scanned or password-protected PDF may need a pasted text copy. You can correct layout and line breaks in the text box.
2. **Review your facts.** PLUTO suggests contact fields and phrases from the résumé. Each suggested fact includes its source and original wording. Edit, deselect or add facts, and use the paging controls to review longer lists. Deselecting a fact removes it from the confirmed list. To remove it from the saved résumé as well, edit the source text.
3. **Set your job preferences.** Existing preferences and explicitly labeled target roles or preferred locations are shown for review. Fill missing preferences or choose **Edit preferences**. Leaving a preference empty keeps it open.
4. **Confirm your profile.** Inspect the details, selected facts and résumé text, check the confirmation box and save. **Edit profile** opens this workflow again. Canceling edits or leaving before saving discards the draft.

### Optional chat excerpt

Expand **Add a selected chat excerpt**. Paste the specific passage or pick a UTF-8 TXT file containing only that passage. Check **Use only this excerpt** to generate suggestions. Changing the passage requires fresh permission. Excerpt suggestions begin unchecked. Only selected phrases and their original wording are saved. The wizard has no connection to a chat account, conversation archive or remote AI service.

### Import boundaries

- Files must be regular files selected through the native dialog. Supported extensions are case-insensitive. File links, folders, relative paths, network-style paths and unsupported extensions are rejected. The picker returns only the basename and extracted text.
- The file limit is 5 MiB. PDFs support up to 40 pages of selectable text. DOCX imports use the main Word document body only, with a 2 MiB decompressed limit and up to 2,048 archive entries. TXT supports UTF-8 and UTF-16 with a byte-order mark. Each résumé is limited to 80,000 characters.
- A selected excerpt file is limited to 32 KiB and the editable excerpt to 8,000 characters. Suggestions use up to 32 résumé phrases and 16 excerpt phrases of up to 1,800 characters each. Longer passages remain available in the source editor. Add any missing facts manually.

### Desktop integration

The default React export receives `{state, refresh, notify}`. The existing `resume.pick` action calls `createResume({dialog, window}).pick()`, where `window` is a getter. It takes no renderer path, returns `null` on cancellation, and otherwise returns `{name, text}`. Parsing requires the packaged `pdfjs-dist` legacy module, its sibling worker and `fflate`.

After confirmation, the wizard reads `workspace.snapshot` and sends changed fields to the existing merge-based `workspace.saveProfile` action. An overlapping change to a reviewed field prompts the user to reopen the editor. Unrelated profile fields remain in storage. The fields are `profileConfirmed`, `name`, `email`, `phone`, `summary`, `resumeText`, `resumeSource`, `targetRoles`, `location` and `confirmedFacts`. Both preferences are strings. Facts contain `text` and a `source` label, plus the source `quote` and optional section when available. Existing string facts can also be edited.
