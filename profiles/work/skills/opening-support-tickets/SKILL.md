---
name: opening-support-tickets
description: "Opens a PostHog support ticket on behalf of a community or forum user who cannot open one themselves, usually a free org that needs PostHog to act (data deletion, account or billing fixes). Use for \"open a ticket for them\", \"create a ticket on their behalf\", a forum post that needs support, or when diagnosing-posthog-customers finds a free org it cannot route. Shows every draft first and sends nothing without an explicit go-ahead."
---

# Opening a ticket on someone's behalf

A free org past its onboarding window cannot open a ticket from Help, so a forum post that
needs PostHog to act dead-ends unless someone opens the ticket for them. Support's agreed
route is an outbound email ticket, kept out of the forum.

The ticket is Support's to work, not the carbon unit's: a sign-off or a first-person plan in
the note reads to Support as the carbon unit working it, and the ticket sits.

## Step 1: Gather

Get the person's email (their posthog.com forum profile shows it) and the forum post link
from the carbon unit. Ask for whichever is missing, and use only an address they gave.

## Step 2: Draft all three

Write each with `writing-in-voice` and the Customer reply rules in
`diagnosing-posthog-customers` (scope, their own data only), with the sign-off below in
place of theirs:

1. **Ticket message**, the email they receive. Open with "We created this ticket for you on
   behalf of your community post:" linking the post, quote its core question, then "Our
   support team will follow up here." Follow with exactly what we need from them and any
   limit that changes their expectation. End with `Thanks!`, then `The PostHog team` on its
   own line. Give it a plain subject line.
2. **Internal note**, team only. Open with a friendly handoff in the carbon unit's voice:
   they opened this on behalf of a forum user for Support to handle, they are not working
   it, and Support should pick it up. Then give context only, in the third person: the
   forum post, what the person asks for, and what the message asked them to send. Tag
   someone only when the carbon unit names them, saying why;
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
3. Report the ticket link, any @mention still owed, and the forum reply to paste, and
   remind the carbon unit that Support owns the ticket.
