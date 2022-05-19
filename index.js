const Heroku = require('heroku-client');
const core = require('@actions/core');
const github = require('@actions/github');

const VALID_EVENT = 'pull_request';

const waitSeconds = (secs) =>
  new Promise((resolve) => setTimeout(resolve, secs * 1000));

async function run() {
  try {
    const githubToken = core.getInput('github_token', { required: true });
    const herokuApiToken = core.getInput('heroku_api_token', {
      required: true,
    });
    const herokuPipelineId = core.getInput('heroku_pipeline_id', {
      required: true,
    });

    const octokit = new github.getOctokit(githubToken);
    const heroku = new Heroku({ token: herokuApiToken });

    const {
      action,
      eventName,
      payload: {
        pull_request: {
          head: {
            ref: branch,
            sha: version,
            repo: { id: repoId, fork: forkRepo, html_url: repoHtmlUrl },
          },
          number: prNumber,
        },
      },
      issue: { number: issueNumber },
      repo,
    } = github.context;

    const { owner: repoOwner } = repo;

    if (eventName !== VALID_EVENT) {
      throw new Error(`Unexpected github event trigger: ${eventName}`);
    }

    const sourceUrl = `${repoHtmlUrl}/tarball/${version}`;
    const forkRepoId = forkRepo ? repoId : undefined;

    const getAppDetails = async (id) => {
      const url = `/apps/${id}`;
      core.debug(`Getting app details for app ID ${id} (${url})`);
      const appDetails = await heroku.get(url);
      core.info(
        `Got app details for app ID ${id} OK: ${JSON.stringify(appDetails)}`,
      );
      return appDetails;
    };

    const outputAppDetails = (app) => {
      core.startGroup('Output app details');
      const { id: appId, web_url: webUrl } = app;
      core.info(`Review app ID: "${appId}"`);
      core.setOutput('app_id', appId);
      core.info(`Review app Web URL: "${webUrl}"`);
      core.setOutput('app_web_url', webUrl);
      core.endGroup();
    };

    const findReviewApp = async () => {
      const apiUrl = `/pipelines/${herokuPipelineId}/review-apps`;
      core.debug(`Listing review apps: "${apiUrl}"`);
      const reviewApps = await heroku.get(apiUrl);

      core.debug(`Finding review app for PR #${prNumber}...`);
      const app = reviewApps.find((app) => app.pr_number === prNumber);

      if (!app) {
        core.info(`No review app found for PR #${prNumber}`);
        return null;
      }

      return app;
    };

    const waitReviewAppUpdated = async () => {
      core.startGroup('Ensure review app is up to date');

      const checkBuildStatusForReviewApp = async (app) => {
        core.debug(`Checking build status for app: ${JSON.stringify(app)}`);
        if ('pending' === app.status || 'creating' === app.status) {
          return false;
        }
        if ('deleting' === app.status) {
          return false;
        }
        if (!app.app) {
          throw new Error(`Unexpected app status: "${app.status}"`);
        }
        const {
          app: { id: appId },
          status,
          error_status: errorStatus,
        } = app;

        core.debug(`Fetching latest builds for app ${appId}...`);
        const latestBuilds = await heroku.get(`/apps/${appId}/builds`);
        core.debug(
          `Fetched latest builds for pipeline ${appId} OK: ${latestBuilds.length} builds found.`,
        );
        core.info(`latestBuilds: ${JSON.stringify(latestBuilds)}`);
        core.info(`Finding build matching version ${version}...`);
        const build = await latestBuilds.find(
          (build) => version === build.source_blob.version,
        );
        if (!build) {
          core.info(`Could not find build matching version ${version}.`);
          core.info(
            `No existing build for app ID ${appId} matches version ${version}`,
          );
          core.info(`build status: "${status}"`);
        }
        core.info(
          `Found build matching version ${version} OK: ${JSON.stringify(
            build,
          )}`,
        );
        core.debug('XXXX XXXX XXXX XXXX XXXX XXXX XXXX XXXX XXXX');

        switch (build.status) {
          case 'succeeded':
            return true;
          case 'pending':
            return false;
          default:
            throw new Error(
              `Unexpected build status: "${status}": ${
                errorStatus || 'no error provided'
              }`,
            );
        }
      };

      let reviewApp = await findReviewApp();

      let isFinished = await checkBuildStatusForReviewApp(reviewApp);

      if (!isFinished) {
        core.info(`Waiting for build to finish...`);
      }

      do {
        reviewApp = await findReviewApp();
        isFinished = await checkBuildStatusForReviewApp(reviewApp);

        if (isFinished) {
          core.info(`Build finished!`);
        }

        core.debug('YYYY YYYY YYYY YYYY YYYY YYYY YYYY YYYY YYYY YYYY ');
        await waitSeconds(5);
      } while (!isFinished);
      core.endGroup();

      core.debug('ZZZZ ZZZZ ZZZZ ZZZZ ZZZZ ZZZZ ZZZZ ZZZZ ZZZZ ZZZZ');
      return getAppDetails(reviewApp.app.id);
    };

    const createReviewApp = async () => {
      try {
        core.info('Creating new review app...');
        core.startGroup('Creating new review app');

        const archiveBody = {
          owner: repoOwner,
          repo: repo.repo,
          ref: version,
        };
        core.debug(`Fetching archive: ${JSON.stringify(archiveBody)}`);
        const { url: archiveUrl } =
          await octokit.rest.repos.downloadTarballArchive(archiveBody);
        core.info(`Fetched archive OK: ${JSON.stringify(archiveUrl)}`);

        const body = {
          branch,
          pipeline: herokuPipelineId,
          source_blob: {
            url: archiveUrl,
            version,
          },
          fork_repo_id: forkRepoId,
          pr_number: prNumber,
          environment: {
            GIT_REPO_URL: repoHtmlUrl,
          },
        };
        core.debug(`Creating heroku review app: ${JSON.stringify(body)}`);
        const app = await heroku.post('/review-apps', { body });
        core.info('Created review app OK:', app);
        core.endGroup();

        return app;
      } catch (err) {
        // 409 indicates duplicate; anything else is unexpected
        if (err.statusCode !== 409) {
          throw err;
        }
        // possibly build kicked off after this PR action began running
        core.warning('Review app now seems to exist after previously not...');
        core.endGroup();

        // just some sanity checking
        const app = await findReviewApp();
        if (!app) {
          throw new Error('Previously got status 409 but no app found');
        }
        return app;
      }
    };

    core.debug(
      `Deploy info: ${JSON.stringify({
        branch,
        version,
        repoId,
        forkRepo,
        forkRepoId,
        repoHtmlUrl,
        prNumber,
        issueNumber,
        repoOwner,
        sourceUrl,
      })}`,
    );

    if (forkRepo) {
      core.notice('No secrets are available for PRs in forked repos.');
      return;
    }

    // Only people that can close PRs are maintainers or the author
    // hence can safely delete review app without being collaborator
    if ('closed' === action) {
      core.debug('PR closed, deleting review app...');
      const app = await findReviewApp();
      if (app) {
        await heroku.delete(`/review-apps/${app.id}`);
        core.info('PR closed, deleted review app OK');
        core.endGroup();
      } else {
        core.error(`Could not find review app for PR #${prNumber}`);
        core.setFailed(
          `Action "closed", yet no existing review app for PR #${prNumber}`,
        );
      }
      return;
    }

    const app = await findReviewApp();
    if (app) {
      core.info('Destroying Review App');
      await heroku.delete(`/apps/${app.id}`).catch((err) => {
        core.notice(`Error destroying app: ${err}`);
      });

      let destroyStatus = 'deleting';

      do {
        reviewApp = await findReviewApp();

        core.info(
          `Waiting for review app to be destroyed... ${JSON.stringify(
            reviewApp,
          )}`,
        );

        if (reviewApp) {
          destroyStatus = reviewApp.status;
        }

        await waitSeconds(5);
      } while (destroyStatus === 'deleting');
    }

    await createReviewApp();

    const updatedApp = await waitReviewAppUpdated();
    outputAppDetails(updatedApp);
  } catch (err) {
    core.error(err);
    core.setFailed(err.message);
  }
}

run();
