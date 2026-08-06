#!/usr/bin/env bash
#
# audit-api-reachability — re-derive what a cloud session can reach on the raw
# GitHub API, and fail on drift IN EITHER DIRECTION from the posture the docs
# claim (docs/api-reachability.md).
#
# The expectations below are not a snapshot to be refreshed — they are the
# session strategy's invariants, asserted:
#
#   I1  repo-scoped READS are open           → the verify loop needs no MCP
#   I2  content WRITES are closed            → `git push` is the write path,
#                                              and the proxy enforces that
#   I3  workflow dispatch is closed here     → ticket windows are driven via
#                                              the MCP `actions_run_trigger`
#                                              tool, never raw curl
#   I4  GraphQL is closed entirely           → ProjectV2 has no session route;
#                                              board work goes through windows
#   I5  everything non-/repos is closed      → search/org/user surfaces exist
#                                              only over MCP
#
# A probe that FAILS OPEN is as much drift as one that fails closed: if a
# "blocked" row starts answering, the proxy policy changed and every paragraph
# built on "the egress proxy is a policy point" needs re-reading. That is why
# this asserts both directions instead of just checking that reads still work.
#
# WHAT THIS ESTABLISHES — and WHAT IT DOES NOT
# --------------------------------------------
# Establishes the RAW-API posture only. The MCP github server holds its own
# credential and its own policy — search_issues answers over MCP while the same
# path 403s here — so nothing below says what an MCP tool can do. The MCP half
# of I3 (that `actions_run_trigger` actually dispatches) is verified only by
# driving a real window loop (claim → verdict), which is a production action
# this script deliberately does not take.
#
# EVERY PROBE IS NON-MUTATING BY CONSTRUCTION, not by expectation. Write-shaped
# probes aim at nonexistent ids (99999999), the all-zeros sha, or invalid
# payloads ({}), so even a probe that unexpectedly passes the proxy cannot
# create or change anything — GitHub refuses it with 404/422, and that refusal
# is itself the evidence the path is served. Do not "fix" a probe by making its
# payload valid.
#
# Exit 0: every probe matched its expectation. Exit 1: drift (printed).
# AUDIT_REPO overrides the target repo; AUDIT_VERBOSE=1 prints response bodies.
#
# Expectations encode the CLOUD-SESSION posture (GH_TOKEN=proxy-injected). Run
# elsewhere, drift is expected and means nothing.

set -u

REPO="${AUDIT_REPO:-bounded-systems/front-desk-scheduler}"
API="https://api.github.com"
VERBOSE="${AUDIT_VERBOSE:-}"

if [ "${GH_TOKEN:-}" != "proxy-injected" ]; then
  echo "WARN: GH_TOKEN is not the proxy-injected sentinel — this is not a cloud" >&2
  echo "      session, and the expectations below describe one. Expect drift." >&2
fi

# ---------------------------------------------------------------------------
# classification — the five refusal classes, plus `open` and `egress`
# ---------------------------------------------------------------------------
classify() {
  local code="$1" body="$2"
  case "$code" in
    2*) echo open; return ;;
    000) echo egress; return ;;
  esac
  case "$body" in
    *"bound to their configured repositories"*)        echo scope ;;
    *"Write access to this GitHub API path"*)          echo proxy-write ;;
    *"Access to this GitHub API path is not permitted"*) echo proxy-path ;;
    *"Merging pull requests is not permitted"*)        echo merge-block ;;
    *"not enabled for this session"*)                  echo graphql ;;
    *"Resource not accessible by integration"*)        echo token ;;
    *)
      # 404/409/422 with no proxy message: the path was SERVED and GitHub
      # refused on existence/validation — which is `open` for a probe aimed
      # at a nonexistent id on purpose.
      case "$code" in
        404|409|422) echo open ;;
        *) echo "unexpected-$code" ;;
      esac ;;
  esac
}

request() { # method path data -> sets CODE, BODY
  local method="$1" path="$2" data="$3"
  local args=(-sS --max-time 30 -w $'\n%{http_code}' -X "$method"
    -H "Accept: application/vnd.github+json"
    -H "Content-Type: application/json"
    -H "Authorization: Bearer ${GH_TOKEN:-unset}")
  [ -n "$data" ] && args+=(-d "$data")
  local out
  out=$(curl "${args[@]}" "$API$path" 2>&1) || { CODE=000 BODY="$out"; return; }
  CODE=$(printf '%s' "$out" | tail -1)
  BODY=$(printf '%s' "$out" | sed '$d')
}

PASS=0 DRIFT=0 SKIP=0
verdict() { # id expect got code
  local mark="ok"
  if [ "$3" = "$2" ]; then PASS=$((PASS+1)); else mark="DRIFT"; DRIFT=$((DRIFT+1)); fi
  printf '%-6s %-34s expect=%-12s got=%-14s http=%s\n' "$mark" "$1" "$2" "$3" "$4"
}

probe() { # id expect method path data
  request "$3" "$4" "${5:-}"
  verdict "$1" "$2" "$(classify "$CODE" "$BODY")" "$CODE"
  [ -n "$VERBOSE" ] && printf '       %s\n' "$(printf '%s' "$BODY" | tr -d '\n' | cut -c1-160)"
}

# a real open-or-recent PR number, for probes that need the parent to exist so
# that the CHILD's absence is what refuses (add_reply needs this; a fake PR
# hides behind a 403 that is indistinguishable from a block)
LATEST_PR=$(request GET "/repos/$REPO/pulls?state=all&per_page=1" "" ; printf '%s' "$BODY" \
  | tr -d ' \n' | grep -o '"number":[0-9]*' | head -1 | cut -d: -f2)

echo "== raw GitHub API reachability audit — repo=$REPO =="
echo
echo "-- I1: repo-scoped reads (must stay open) --"
probe get_me                open GET  "/user"
probe rate_limit            open GET  "/rate_limit"
probe get_file_contents     open GET  "/repos/$REPO/contents/README.md"
probe list_branches         open GET  "/repos/$REPO/branches?per_page=1"
probe list_commits          open GET  "/repos/$REPO/commits?per_page=1"
probe get_commit            open GET  "/repos/$REPO/commits/HEAD"
probe list_tags             open GET  "/repos/$REPO/tags?per_page=1"
probe get_tag               open GET  "/repos/$REPO/git/ref/tags/zz-audit-none"
probe list_issues           open GET  "/repos/$REPO/issues?per_page=1"
probe issue_read            open GET  "/repos/$REPO/issues/1"
probe get_label             open GET  "/repos/$REPO/labels/bug"
probe list_pull_requests    open GET  "/repos/$REPO/pulls?per_page=1"
probe actions_list          open GET  "/repos/$REPO/actions/workflows"
probe actions_runs          open GET  "/repos/$REPO/actions/runs?per_page=1"
probe get_check_run         open GET  "/repos/$REPO/check-runs/999999999"
probe get_job_logs_meta     open GET  "/repos/$REPO/actions/jobs/999999999/logs"
probe list_releases         open GET  "/repos/$REPO/releases"

echo
echo "-- I1: repo-scoped issue/PR writes (open — these ride the injected token) --"
probe issue_write_create    open POST  "/repos/$REPO/issues" '{}'
probe issue_write_update    open PATCH "/repos/$REPO/issues/99999999" '{"title":"x"}'
probe add_issue_comment     open POST  "/repos/$REPO/issues/99999999/comments" '{"body":"x"}'
probe sub_issue_write       open POST  "/repos/$REPO/issues/99999999/sub_issues" '{"sub_issue_id":1}'
probe create_pull_request   open POST  "/repos/$REPO/pulls" '{}'
probe update_pull_request   open PATCH "/repos/$REPO/pulls/99999999" '{"title":"x"}'
probe update_pr_branch      open PUT   "/repos/$REPO/pulls/99999999/update-branch" '{}'
probe pr_review_write       open POST  "/repos/$REPO/pulls/99999999/reviews" '{"event":"COMMENT","body":"x"}'
probe request_reviewers     open POST  "/repos/$REPO/pulls/99999999/requested_reviewers" '{"reviewers":["copilot-pull-request-reviewer[bot]"]}'
# these two need the PARENT to exist so the child's absence (or an empty
# payload) is what refuses — against a fake PR, GitHub masks with a 403 that
# is indistinguishable from a block
if [ -n "$LATEST_PR" ]; then
  probe pending_review_comment open POST "/repos/$REPO/pulls/$LATEST_PR/comments" '{}'
  probe add_reply_to_pr_comment open POST "/repos/$REPO/pulls/$LATEST_PR/comments/999999999/replies" '{"body":"audit probe"}'
else
  SKIP=$((SKIP+2)); echo "skip   pending_review_comment + add_reply (no PR found to probe against)"
fi

echo
echo "-- I2: content writes (must stay closed — git push is the write path) --"
probe create_or_update_file proxy-write PUT    "/repos/$REPO/contents/zz-audit-none.md" '{"message":"x","content":"eA==","branch":"zz-audit-nonexistent-branch"}'
probe delete_file           proxy-write DELETE "/repos/$REPO/contents/zz-audit-none.md" '{"message":"x","sha":"0000000000000000000000000000000000000000"}'
probe create_branch         proxy-write POST   "/repos/$REPO/git/refs" '{"ref":"refs/heads/zz-audit-none","sha":"0000000000000000000000000000000000000000"}'
probe push_files            proxy-write POST   "/repos/$REPO/git/trees" '{"tree":[]}'
probe fork_repository       proxy-write POST   "/repos/$REPO/forks" '{"organization":"zz-audit-nonexistent-org"}'
probe merge_pull_request    merge-block PUT    "/repos/$REPO/pulls/99999999/merge" '{}'
GIT_OUT=$(git ls-remote "https://github.com/$REPO" HEAD 2>&1)
if printf '%s' "$GIT_OUT" | grep -q 'HEAD'; then
  verdict git_plane open open 200
else
  verdict git_plane open closed 000
fi

echo
echo "-- I3: workflow dispatch (closed at the TOKEN, not the proxy) --"
probe actions_run_trigger   token POST "/repos/$REPO/actions/workflows/999999999/dispatches" '{"ref":"main"}'

echo
echo "-- I4: GraphQL (closed entirely — ProjectV2 has no session route) --"
request POST "/graphql" '{"query":"{ viewer { login } }"}'
verdict graphql_viewer graphql "$(classify "$CODE" "$BODY")" "$CODE"

echo
echo "-- I5: non-/repos surfaces (must stay closed) --"
probe search_code           scope GET "/search/code?q=repo:$REPO+audit&per_page=1"
probe search_issues         scope GET "/search/issues?q=repo:$REPO+is:issue&per_page=1"
probe search_repositories   scope GET "/search/repositories?q=zz&per_page=1"
probe search_commits        scope GET "/search/commits?q=repo:$REPO+x&per_page=1"
probe search_users          scope GET "/search/users?q=zz&per_page=1"
probe get_teams             scope GET "/user/teams"
probe org_teams             scope GET "/orgs/${REPO%%/*}/teams"
probe create_repository     scope POST "/user/repos" '{"name":""}'
probe list_issue_types      scope GET "/orgs/${REPO%%/*}/issue-types"
probe list_collaborators    proxy-path GET "/repos/$REPO/collaborators?per_page=1"
probe secret_scanning       proxy-path GET "/repos/$REPO/secret-scanning/alerts?per_page=1"

echo
echo "-- egress: Actions log bodies live on Azure blob, off the allowlist --"
BLOB_CODE=$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' \
  "https://productionresultssa10.blob.core.windows.net/" 2>/dev/null || true)
BLOB_CODE="${BLOB_CODE:-000}"
verdict job_log_bytes egress "$( [ "$BLOB_CODE" = "000" ] && echo egress || echo open )" "$BLOB_CODE"

echo
echo "== $PASS ok, $DRIFT drift, $SKIP skipped =="
if [ "$DRIFT" -gt 0 ]; then
  echo "Drift means the session posture changed — update docs/api-reachability.md"
  echo "and the paragraphs in CLAUDE.md that lean on it, in the same PR that"
  echo "changes these expectations."
  exit 1
fi
