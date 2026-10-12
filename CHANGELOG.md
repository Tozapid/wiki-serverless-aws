# Changelog

## v1.4.1

### Fixed

- Settings → Version showed the word "null" under the version when no newer release was out.

### Changed

- A `CHANGELOG.md` entry no longer needs a date: `## v1.4.1`, `## v1.4.1 — 2026-10-12` and `## v1.4.1 — a title` all work. GitHub dates the release itself.

## v1.4.0 — 2026-10-12

### Added

- Settings → Version: the version of the site and the releases of the demo repository that came after it, with their notes. The API reads them from the Atom feed of the GitHub releases (`GET /api/version`) and keeps them an hour.
- Versions: every entry of this changelog starts with `vX.Y.Z`. After `main` is deployed, CI makes the tag and the GitHub release of the newest entry if it is not out yet. The site takes its version from the newest entry when it is deployed; `releases_repository` names the repository to compare with.

## v1.3.0 — 2026-10-12

### Changed

- The sign-in page no longer says it is for invited users only; it links to the source code on GitHub beside the language menu, as Hide My Email does.
- The new password fields ask for 8 characters, as the user pool does; they asked for 12.
- Settings as in Hide My Email: the new password is typed twice; two-factor authentication (the name in place of "two-step sign-in" everywhere) shows its state and one button, and pairs in two numbered steps (scan the code or type the key, then the code from the app); the language is a drop-down, as on the sign-in page.
- The index of the DynamoDB table names its keys with `key_schema` blocks instead of `hash_key` and `range_key`, which the AWS provider deprecates inside `global_secondary_index` (6.68).
- `.terraform.lock.hcl` is no longer kept in the repository (it is in `.gitignore`): `terraform init` takes the newest AWS provider within the constraint in `terraform.tf`.

## v1.2.0 — 2026-10-11

### Changed

- CI: the jobs moved to the shared reusable workflow of [Tozapid/demo-ci-cd-skeleton](https://github.com/Tozapid/demo-ci-cd-skeleton); `.github/workflows/terraform.yml` is a short caller, the same in all three projects. The Lambda tests run by discovery (`*_test.py`), the page tests run where `tests/web` exists, the state key is `<repository>/terraform.tfstate`.
- `main` is protected: changes go through pull requests, merged by squash once the checks `ci / Terraform format and validate`, `ci / Lambda tests` and `ci / Frontend tests` pass; merged branches are deleted.
- AWS access through GitHub OIDC: the plan and apply jobs run in the environment `demo` and assume the role in the variable `AWS_ROLE_ARN` (role `github-wiki-serverless-aws`, an entry of `github_roles` in the stack `iam-github-oidc` of the account repository). The secrets `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` and the deploy user with its access key are gone.
- Deploy from a branch: a manual run of the workflow applies the branch it was started from, not only `main`, over the same demo site; the run summary names the branch and warns that the next push to `main` replaces it. Applies from different branches wait for each other.
- The page: one design shared with the sibling projects (Hide My Email, the box inventory and the wiki): the same block of variables and components opens `web/styles.css` in all three and is kept identical — an indigo accent, system fonts, rounded cards, fields, buttons, dialogs, settings, tables and toasts. Light and dark themes follow the system setting. Tiddlers are plain cards without the coloured spine, an edited one is outlined in the accent; headings use the system font instead of a serif; tags and task counts are accent pills. The image viewer stays dark in both themes.
- New favicon in the shared style: a page on indigo.

## v1.1.0 — 2026-09-29

### Added

- Optional two-step sign-in with an authenticator app (TOTP). Settings → "Two-step sign-in" connects an app by QR code or key and a check code, switches to another app or turns it off. Sign-in asks for the code after the password, also after a temporary password is replaced.
- The users list has a 2FA column; an administrator can reset two-step sign-in for someone who lost their phone.
- The Cognito user pool allows TOTP as an option (`mfa_configuration = "OPTIONAL"`); the API Lambda may call `AdminGetUser` and `AdminSetUserMFAPreference`.
- The QR code is drawn by `qrcode-generator` 1.4.4 from jsDelivr, loaded with an integrity hash.
- The hourly demo reset turns two-step sign-in off for the admin.
- Interface tests for the code step at sign-in, the settings and the users list.

### Security

- Users can no longer change their own email. The app client let a signed-in user rewrite it with `UpdateUserAttributes`; the new, unverified address went into the ID token, and the API then treated that user as the owner of someone else's open tiddlers and drafts and signed edits with their email. Administrator rights were not reachable this way: they come from the group. The client now writes only `locale` (an empty list would allow every standard attribute).
- The API accepts only tokens with a verified email (`email_verified`) and answers 403 otherwise.

## v1.0.0 — 2026-09-27

### Changed

- Both Lambda functions (API and demo reset) run on `python3.14` instead of `python3.12`; CI tests them on Python 3.14.
- The text of a tiddler is loaded when the tiddler is opened. Sign-in gets a list without text: 1.46 MB instead of 12.8 MB for 3,000 tiddlers, 4.4 s instead of 7.3 s.
- Links of each tiddler are worked out on save and kept in the table. Backlinks and the Missing tab use them. Tiddlers saved before get their links on the first listing.
- Full-text search and `<<todo>>` run on the server. Titles and tags are still searched at once in the browser.
- The DynamoDB index `tiddlers` holds everything but the text (`INCLUDE` projection).

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
