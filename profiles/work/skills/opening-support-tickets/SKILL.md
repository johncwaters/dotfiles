---
name: opening-support-tickets
description: "Opens a PostHog support ticket on behalf of a community or forum user who cannot open one themselves, usually a free org that needs PostHog to act (data deletion, account or billing fixes). Use for \"open a ticket for them\", \"create a ticket on their behalf\", a forum post that needs support, or when diagnosing-posthog-customers finds a free org it cannot route. Shows every draft first and sends nothing without an explicit go-ahead."
---

# Opening a ticket on someone's behalf

A free org past its onboarding window cannot open a ticket from Help, so a forum post that
needs PostHog to act dead-ends unless someone opens the ticket for them. Support's agreed
route is an outbound email ticket, kept out of the forum. Ticket 75872 is the reference
shape.

## Step 1: Gather

Get the person's email (their posthog.com forum profile shows it) and the forum post link
from the carbon unit. Ask for whichever is missing, and use only an address they gave.

## Step 2: Draft all three

Write each with `writing-in-voice` and the Customer reply rules in
`diagnosing-posthog-customers` (sign-off, scope, their own data only):

1. **Ticket message**, the email they receive. Open with "We created this ticket for you on
   behalf of your community post:" linking the post, quote its core question, then "We'll
   take a look and respond here." Follow with exactly what we need from them and any limit
   that changes their expectation. Give it a plain subject line.
2. **Internal note**, team only: plan, source, and what the ask is. Name anyone to tag;
   `conversations-tickets-notes-create` takes plain text, so the carbon unit adds the
   @mention in the app.
3. **Forum reply**, posted by the carbon unit, saying a ticket went to their email.

## Step 3: Show, then wait

Show all three drafts with the recipient and subject, and stop. Send only after the carbon
unit says to send in their own words; edits to a draft restart this step.

## Step 4: Send

1. `call conversations-tickets-compose-create` with `recipient_email`, `email_subject`,
   and the ticket message. It emails them immediately; the PostHog exec hook asks first.
2. `call conversations-tickets-notes-create` on the returned `ticket_number`.
3. Report the ticket link, any @mention still owed, and the forum reply to paste.
