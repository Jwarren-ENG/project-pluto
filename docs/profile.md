# Résumé-first profile

Saving a planning budget or search preferences first still opens résumé onboarding. Completing the wizard records the explicit profile confirmation.

Open **Profile**, then choose a PDF, DOCX or TXT résumé or paste the text. Review the text before continuing. An empty source also works for manual entry.

1. **Start with your résumé.** The native picker reads one selected file locally. A scanned or password-protected PDF may need a pasted text copy. Expand **View or edit résumé text** to correct layout and line breaks, or **Paste résumé text** to start with a passage.
2. **Review your facts.** Project Pluto suggests contact fields and phrases from the résumé. Use **View source** to inspect the original wording behind a suggestion. Source quotations stay collapsed until opened. Edit, deselect or add facts, and use the paging controls to review longer lists. Deselecting a fact removes it from the confirmed list. To remove it from the saved résumé as well, edit the source text.
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

After confirmation, the wizard reads `workspace.snapshot` and sends changed fields and their expected values to `workspace.saveReviewedProfile({changes, expected})`. The workspace checks those values during the write. The details editor merges separate stories, country entries and answer fields with the latest profile. Conflicting edits prompt a fresh review. Each story and its permission are checked together. The fields are `profileConfirmed`, `name`, `email`, `phone`, `summary`, `resumeText`, `resumeSource`, `targetRoles`, `location` and `confirmedFacts`. Both preferences are strings. Facts contain `text` and a `source` label, plus the source `quote` and optional section when available. Existing string facts can also be edited.

### Experience stories and application answers

In **Set your job preferences**, or directly under **Your profile** after onboarding, choose **Add story** or **Edit application answers**. Both sections are optional. During setup, saving an editor places its changes in the review step. **Save confirmed profile** writes them to the workspace. On a saved profile, **Save story** and **Save answers** write the changes directly.

A story can come from paid work, study, volunteering, caregiving or a personal project. Give it a **Story title**, then describe the **Context**, **What you did**, and **Result or evidence**. A qualitative observation is enough. **Use in application drafts** starts unchecked for each new story. Selecting it permits the drafting provider to receive that story when you request a draft. Edit the story to change permission for future drafts. **Cancel** discards the editor’s changes.

Application answers are local reference material for completing forms. The editor collects an address, professional links, preferred work arrangement, relocation, travel, desired annual base salary and currency, availability, and work authorization and sponsorship by country. **Unanswered** keeps a yes/no question open. No answer is inferred from an address, résumé, or another country’s entry.

#### Stored fields

- `profile.experienceStories` contains `{id,title,context,action,result,useInDrafts}`. The flag is a boolean. Only stories with `useInDrafts === true` are eligible for drafting.
- `profile.applicationAnswers` contains the optional keys `address`, `linkedInUrl`, `portfolioUrl`, `otherUrl`, `workArrangement`, `relocation`, `travel`, `salaryCurrency`, `salaryMin`, `salaryMax`, `startDate`, `notice` and `workAuthorization`. Salary amounts are numbers. Dates use YYYY-MM-DD. Relocation is a boolean. Country entries have a stable `id`, `country`, and optional boolean `authorized` and `sponsorship` fields. Unanswered optional values are omitted. The entire object is excluded from drafting input.
