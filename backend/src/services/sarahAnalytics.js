/**
 * sarahAnalytics.js
 *
 * Server-side Mixpanel tracking for Sarah's OWN product analytics.
 * Separate from mixpanel.js (which queries the *customer's* Mixpanel project).
 *
 * Requires env var: SARAH_MIXPANEL_TOKEN  (project token, not service account)
 *
 * Events tracked:
 *   Sign Up Completed      — workspace installs Sarah via Slack OAuth
 *   Activated              — user receives their first successful data answer
 *   Error Shown            — Sarah sends an error message to a user
 *   Onboarding Started     — user begins Mixpanel setup flow
 *   Onboarding Step Completed — each step of Mixpanel setup (1-3)
 *   Jira Connected         — user completes Jira OAuth
 *
 * User properties (via /engage):
 *   plan, mrr, arpu, account_id  (Gap 5)
 */

import axios from 'axios';

const MIXPANEL_TRACK_URL  = 'https://api.mixpanel.com/track';
const MIXPANEL_ENGAGE_URL = 'https://api.mixpanel.com/engage';

function getToken() {
  return process.env.SARAH_MIXPANEL_TOKEN || null;
}

/**
 * Send one or more events to Mixpanel ingestion API.
 * Silently no-ops if SARAH_MIXPANEL_TOKEN is not set.
 *
 * @param {object|object[]} events
 */
async function sendEvents(events) {
  const token = getToken();
  if (!token) return; // analytics opt-out or not yet configured

  const payload = Array.isArray(events) ? events : [events];

  try {
    await axios.post(
      MIXPANEL_TRACK_URL,
      { data: payload },
      {
        headers: { 'Content-Type': 'application/json', Accept: 'text/plain' },
        params: { verbose: 1, ip: 0 },
      }
    );
  } catch (err) {
    // Never let analytics errors surface to users
    console.warn('[SarahAnalytics] track failed:', err.message);
  }
}

/**
 * Set or update Mixpanel People properties for a workspace/user.
 * @param {string} distinctId — workspaceId (or userId for per-user props)
 * @param {object} props
 */
async function setUserProperties(distinctId, props) {
  const token = getToken();
  if (!token) return;

  try {
    await axios.post(
      MIXPANEL_ENGAGE_URL,
      {
        data: {
          $token: token,
          $distinct_id: distinctId,
          $set: props,
        },
      },
      {
        headers: { 'Content-Type': 'application/json', Accept: 'text/plain' },
        params: { verbose: 1 },
      }
    );
  } catch (err) {
    console.warn('[SarahAnalytics] engage failed:', err.message);
  }
}

/**
 * Build a Mixpanel event object.
 */
function makeEvent(eventName, distinctId, props = {}) {
  const token = getToken();
  return {
    event: eventName,
    properties: {
      token,
      distinct_id: distinctId,
      time: Math.floor(Date.now() / 1000),
      ...props,
    },
  };
}

// ---------------------------------------------------------------------------
// Gap 1 — Sign Up Completed (Slack workspace install)
// ---------------------------------------------------------------------------

/**
 * Call after successful Slack OAuth callback — workspace is now installed.
 *
 * @param {string} workspaceId
 * @param {string} teamName
 * @param {object} utmProps — { utm_source, utm_medium, utm_campaign, referrer, landing_page }
 */
export async function trackSignUpCompleted(workspaceId, teamName, utmProps = {}) {
  await Promise.all([
    sendEvents(makeEvent('Sign Up Completed', workspaceId, {
      workspace_id:  workspaceId,
      team_name:     teamName,
      utm_source:    utmProps.utm_source    || '$organic',
      utm_medium:    utmProps.utm_medium    || null,
      utm_campaign:  utmProps.utm_campaign  || null,
      referrer:      utmProps.referrer      || 'direct',
      landing_page:  utmProps.landing_page  || null,
    })),
    // Also set People properties so the workspace appears in Mixpanel Users
    setUserProperties(workspaceId, {
      $name:         teamName,
      workspace_id:  workspaceId,
      plan:          'free',          // default; update on upgrade
      mrr:           0,
      arpu:          0,
      created_at:    new Date().toISOString(),
      ...utmProps,
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Gap 2 — Activated (first successful data answer)
// ---------------------------------------------------------------------------

/**
 * Call after Claude returns a non-error response — but ONLY once per user
 * (caller must gate with a 'activated' user_flag from the DB).
 *
 * @param {string} workspaceId
 * @param {string} userId — Slack user ID
 * @param {object} props — { feature_name, days_to_activate, session_count }
 */
export async function trackActivated(workspaceId, userId, props = {}) {
  await sendEvents(makeEvent('Activated', userId, {
    workspace_id:       workspaceId,
    feature_name:       props.feature_name       || null,
    activation_trigger: props.activation_trigger || 'first_data_answer',
    days_to_activate:   props.days_to_activate   || null,
  }));
}

// ---------------------------------------------------------------------------
// Gap 2 + 4 — Error Shown
// ---------------------------------------------------------------------------

/**
 * Call whenever Sarah sends an error message to a user.
 *
 * @param {string} workspaceId
 * @param {string} userId
 * @param {object} props — { error_code, error_screen, feature_name, onboarding_step }
 */
export async function trackErrorShown(workspaceId, userId, props = {}) {
  await sendEvents(makeEvent('Error Shown', userId, {
    workspace_id:    workspaceId,
    feature_name:    props.feature_name    || null,
    error_code:      props.error_code      || null,
    error_message:   props.error_message   || null,
    error_screen:    props.error_screen    || null,
    onboarding_step: props.onboarding_step || null,
  }));
}

// ---------------------------------------------------------------------------
// Gap 3 — Onboarding Steps (Mixpanel setup flow)
// ---------------------------------------------------------------------------

/**
 * Call when user sends first message in the Mixpanel setup flow.
 */
export async function trackOnboardingStarted(workspaceId, userId) {
  await sendEvents(makeEvent('Onboarding Started', userId, {
    workspace_id: workspaceId,
    step_number:  1,
    step_name:    'project_id',
  }));
}

/**
 * Call when a setup step is completed.
 *
 * Step map:
 *   1 = project_id entered
 *   2 = username entered
 *   3 = secret entered (confirm screen shown)
 *   4 = connection verified + saved
 *
 * @param {string} workspaceId
 * @param {string} userId
 * @param {number} stepNumber
 * @param {string} stepName
 */
export async function trackOnboardingStepCompleted(workspaceId, userId, stepNumber, stepName) {
  await sendEvents(makeEvent('Onboarding Step Completed', userId, {
    workspace_id: workspaceId,
    step_number:  stepNumber,
    step_name:    stepName,
  }));
}

/**
 * Call when Mixpanel connection is confirmed and saved successfully.
 */
export async function trackOnboardingCompleted(workspaceId, userId) {
  await sendEvents(makeEvent('Onboarding Completed', userId, {
    workspace_id: workspaceId,
    integration:  'mixpanel',
  }));
}

/**
 * Call when Jira OAuth completes.
 */
export async function trackJiraConnected(workspaceId, userId) {
  await sendEvents(makeEvent('Jira Connected', userId, {
    workspace_id: workspaceId,
    integration:  'jira',
  }));
}

// ---------------------------------------------------------------------------
// Gap 5 — ARPU / MRR user properties
// ---------------------------------------------------------------------------

const PLAN_MRR = {
  free:       0,
  starter:    49,
  pro:        99,
  enterprise: 499,
};

/**
 * Update revenue properties on a workspace profile.
 * Call after install (plan='free') and after any plan change.
 *
 * @param {string} workspaceId
 * @param {string} plan — 'free' | 'starter' | 'pro' | 'enterprise'
 * @param {number|null} mrrOverride — actual MRR from billing if available
 */
export async function setWorkspaceRevenue(workspaceId, plan, mrrOverride = null) {
  const mrr  = mrrOverride ?? (PLAN_MRR[plan] ?? 0);
  const arpu = mrr * 12;
  await setUserProperties(workspaceId, { plan, mrr, arpu });
}
