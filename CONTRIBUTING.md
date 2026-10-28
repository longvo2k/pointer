# Contributing

Thanks for helping. Pointer is small on purpose, so most changes are short.

## Set up

```bash
git clone https://github.com/longvo2k/pointer && cd pointer
npm install
npm test
```

Load `extension/` at `chrome://extensions` (Developer mode → Load unpacked) to try changes in Chrome.
After editing the extension, use **Remove** and **Load unpacked** if Chrome keeps running the old copy
(`pointer browsers` flags it as stale).

## Where things go

- Browser mechanics: `extension/` (the service worker owns the hub connection and debugger; the
  content script owns snapshots and the cursor).
- New tools and the text agents read: `lib/tools.mjs`.
- Routing between browsers: `lib/hub.mjs`. Keep it a router.
- Guidance for agents: `skills/pointer/SKILL.md`.

## Rules that keep Pointer trustworthy

- No tool that runs arbitrary JavaScript in a page.
- No network requests to anything but `127.0.0.1`. No analytics.
- No new runtime dependencies without a strong reason.
- Never weaken the hub's request checks; `test/hub.test.mjs` covers them.

CI runs `npm run check`, `npm test`, and checks for outside URLs and dynamic code on every pull
request.

## Releasing

```bash
git checkout -b release/0.2.22
npm run release 0.2.22      # sets the version in all five places
git commit -am "chore: release 0.2.22"
```

Open a PR and merge it. On `main`, the Release workflow sees a version with no tag, runs the
tests, tags `v0.2.22`, publishes to npm, and submits the extension to the Chrome Web Store (the
zip is also attached to the GitHub release). The store version goes live after Google's review.
If a publish step fails, fix the cause and click **Re-run failed jobs**.

### One-time setup for the Chrome Web Store

The workflow signs in to Google with Workload Identity Federation, so no key is stored.

1. In Google Cloud (any project), enable the APIs and create a service account:

   ```bash
   PROJECT=your-project-id
   NUMBER=$(gcloud projects describe $PROJECT --format='value(projectNumber)')
   gcloud services enable chromewebstore.googleapis.com iamcredentials.googleapis.com --project $PROJECT
   gcloud iam service-accounts create pointer-release --project $PROJECT
   gcloud iam workload-identity-pools create github --location=global --project $PROJECT
   gcloud iam workload-identity-pools providers create-oidc pointer \
     --location=global --workload-identity-pool=github --project $PROJECT \
     --issuer-uri=https://token.actions.githubusercontent.com \
     --attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository \
     --attribute-condition="assertion.sub=='repo:longvo2k/pointer:environment:chrome-web-store'"
   gcloud iam service-accounts add-iam-policy-binding \
     pointer-release@$PROJECT.iam.gserviceaccount.com --project $PROJECT \
     --role=roles/iam.workloadIdentityUser \
     --member="principalSet://iam.googleapis.com/projects/$NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/longvo2k/pointer"
   ```

2. In the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole),
   open **Account** and add `pointer-release@<project>.iam.gserviceaccount.com` as the service
   account. Note the publisher ID under **Publisher → Settings**.

3. In GitHub, create the `chrome-web-store` environment (Settings → Environments) and set these
   repository variables:

   ```bash
   gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER \
     --body "projects/$NUMBER/locations/global/workloadIdentityPools/github/providers/pointer"
   gh variable set GCP_SERVICE_ACCOUNT --body "pointer-release@$PROJECT.iam.gserviceaccount.com"
   gh variable set CWS_PUBLISHER_ID --body "<publisher id>"
   ```

Security problems: see [SECURITY.md](SECURITY.md), not a public issue.
