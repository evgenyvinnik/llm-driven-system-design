# Incident Response Runbook

This runbook describes how the engineering on-call rotation handles production incidents.

## Severity levels

A SEV1 incident is a full outage or data loss affecting customers. A SEV2 incident is a partial outage or a severe degradation of a core feature. A SEV3 incident is a minor bug with a workaround.

## Paging and escalation

The primary on-call engineer must acknowledge a page within 5 minutes. If the primary does not acknowledge within 5 minutes, the page escalates to the secondary on-call engineer. For a SEV1, the incident commander also pages the engineering manager and opens a status page update within 15 minutes.

## During the incident

Open a dedicated incident channel and post updates every 30 minutes. Prefer rolling back the latest deployment over debugging forward when a release is the likely cause.

## After the incident

Write a blameless postmortem within five business days of every SEV1 and SEV2 incident. Track every follow-up action in the engineering backlog with an owner and a due date.
