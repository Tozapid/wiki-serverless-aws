# Changelog

## 2026-09-27

### Changed

- Both Lambda functions (API and demo reset) run on `python3.14` instead of `python3.12`; CI tests them on Python 3.14.
- The text of a tiddler is loaded when the tiddler is opened. Sign-in gets a list without text: 1.46 MB instead of 12.8 MB for 3,000 tiddlers, 4.4 s instead of 7.3 s.
- Links of each tiddler are worked out on save and kept in the table. Backlinks and the Missing tab use them. Tiddlers saved before get their links on the first listing.
- Full-text search and `<<todo>>` run on the server. Titles and tags are still searched at once in the browser.
- The DynamoDB index `tiddlers` holds everything but the text (`INCLUDE` projection).
- The built-in help is called `$:/Markup` instead of `$:/Разметка`.

### Fixed

- The example photo showed the 5.6 MB original. It now shows a 1920 px WebP copy made by the page's own upload code, and the original opens on click, as with an uploaded photo.
- An open preview in the editor stayed at "Loading…" when a text or the task list arrived after it was drawn.
- A tiddler deleted on the server while its text was being loaded was asked for again on every redraw.
- The last step of the GitHub Actions workflow did not parse as YAML, so the first run did not start.

### Added

- Example tiddlers in the demo, written again by every hourly reset: a video, a photo, a table, task lists with a `<<todo>>` summary and lorem ipsum. They open at sign-in next to the help. Their files live under `files/seed/` in the files bucket; the reset and the cleanup of unused files leave them alone.
- Frontend tests in `tests/web/`: markup renderer, translations, link and task rules against the Lambda, and the interface in headless Chrome. GitHub Actions runs them, the Lambda tests and the Terraform checks as three separate jobs; plan and apply wait for all three.
- Stress test with 3,000 tiddlers in the README.
- Link to the demo in the README.
- The wiki: tiddlers with tags, links, history, drafts, task lists, media and four interface languages, on S3, CloudFront, API Gateway, Lambda, DynamoDB and Cognito. Public demo on the CloudFront address with an hourly reset, deployed by GitHub Actions with state in S3.
