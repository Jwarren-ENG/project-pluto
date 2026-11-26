# Workspace storage and notebook

## Using Notebook

Open **Notebook** from the sidebar or **Open notebook** on Today. Search for a note by its title, Markdown text, company or role. Select its title to read or edit it. Long notes scroll inside the Markdown field. When a note has a linked source, **Open original note in Obsidian** opens that page.

Choose **New note** to start with a blank page. Give it a title, select a linked application or leave it as **General note**, and choose **Save note**. If a tracker refreshes a note while you are reading it, the editor shows the latest saved text. If you have local edits, Pluto keeps them in the form and asks you to resolve the newer version before saving. **Keep editing** returns to your draft. **Discard edits and load saved version** lets you review the tracker’s copy.

### Study guides and interview prep

Use **Manage in Connections** to open **Optional workflows**. **Study guides** and **Interview prep** have independent switches. Both start off. Your existing notes and manual editor are available with either setting.

To draft a preparation note, configure a drafting provider and review your experience in **Profile**. In **Notebook**, select a **Tracked role** and choose **Draft study guide** or **Draft interview prep**. That click sends the selected role and the profile material eligible for drafting to your configured provider. Your model allowance or API pricing applies.

The result opens as an unsaved note linked to the selected role. Review the Markdown, change the title or text, then choose **Save note**. To dismiss the draft, choose **Close** and **Discard changes**. A saved guide or interview note remains editable after you switch its workflow off.

## Local storage

Call `createWorkspace(directory)` from the main process. A workspace uses the bundled SQLite engine and stores its data in `workspace.sqlite3`. Each save runs in one transaction. Multiple workspace handles can use the same directory. For a complete backup, close the application and copy its workspace directory.

## Reading and saving

`snapshot()` returns the reviewed profile, jobs, notes and schedule in one consistent read. Jobs and notes sort by most recent edit. The snapshot includes two dashboard collections.

| Field | Contents |
| --- | --- |
| `evidence` | Employer evidence in reverse chronological order, including job ID, company, title, stage, recording time and any interview time. |
| `upcomingInterviews` | Jobs currently at Interview with a future scheduled time, ordered by appointment. Each entry has jobId, company, title and interviewAt. |

Each job has a stable ID, createdAt, updatedAt, history and submittedSnapshot. Methods are synchronous. Each save returns the saved record. Pass the editor's original updatedAt when updating an existing job or note. A stale save raises an error and keeps the newer record. Omitted fields retain their prior values. A caller may supply a stable ID when creating a note, for example to link the same employer message only once.

A new job defaults to Saved. Save Preparing for work in progress. Enter new employer evidence when moving into Applied, Interview, Offer or Closed. Evidence can be a receipt quotation or a small object containing text, source, url, messageId, subject, receivedAt or reference. An interview invitation can establish Interview directly. A scheduled time accepts ISO date and time and is returned in UTC. The UI displays local time.

When recording Applied, pass the exact reviewed resumeText and draft that went to the employer. The first receipt freezes those strings, the role, company, URL and recording time in submittedSnapshot. An empty material field means its text was unavailable. Later edits can change the working résumé or draft. Receipt and outcome history stays available. The provider, credentials and mail accounts belong to their respective services.

## Working with Obsidian

Pass the selected vault directory to either vault method. Export creates a Project Pluto folder under it. Vaults created by older versions keep using their existing folder. It writes a case page for each job and a Markdown page for each note. The profile and connection settings stay in the application. Case pages *do* contain the recorded receipt and submitted materials, so select a vault appropriate for that information.

The pluto-type and pluto-id frontmatter fields identify each page. You can rename a page or move it into a subfolder within Project Pluto. Additional frontmatter such as tags is retained. A note's first heading is its title. The remaining Markdown is its body. An optional pluto-job field links the note to an existing job ID.

Edit case annotations below the record marker. Import brings those annotations and edited notes into Pluto. Case stage, receipts and submitted materials come from the workspace. A manual change to the generated part of a case is reported for review. A vault can transfer independent managed notes to another workspace. Linked notes require their job to exist there.

Both vault methods return written, imported and unchanged counts and two arrays, preserved and conflicts. Display each affected path and reason. Export leaves a one-sided vault edit in place for import. If both copies changed since the last sync, keep the desired text from both, make the copies agree and sync again. Duplicate IDs, missing linked jobs and edits to the generated case section include a specific reason. Missing pages stay missing on export. Other Markdown files and symlinks are left alone.

Run `node --test tests/workspace.test.mjs` to exercise persistence, receipt protection, rollback, optimistic concurrency and the vault round trip.

## Panel integration

Applications and Notebook are default exports. Both accept the shared state, refresh and notify props. Applications uses seed and setSeed for the selected or discovered role. Close clears the seed. The editor sends its original updatedAt on every update. If another window saves first, it keeps the local text visible and offers to load the newer copy.

The employer and PDF buttons call application.open and application.pdf with the saved job ID. Save changes to the relevant URL or reviewed résumé before using its button. Draft with AI sends the reviewed profile fields and role details only on a click. A generated replacement is shown beside the current draft for review.

Notebook reads the study guide and interview prep switches from `state.features`. An explicit generation request calls `learning.draft` with the selected kind and saved job ID. Main checks the switch and reviewed profile material, resolves the job, and returns Markdown from the configured provider. **Save note** uses the ordinary workspace save path.

Run `node tests/notebook-desktop.mjs` from a built checkout to exercise the native Notebook with a disposable managed note, Obsidian folder and local model fixture.
