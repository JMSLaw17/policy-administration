/**
 * What the submission video says, one entry per beat. The recording script
 * (video/record.spec.ts) shows each beat on screen for as long as its line
 * takes to say, so editing a line here changes the pacing of the video too.
 *
 * The id of each line is also the file name for your own recording of it:
 * save video/voice/<id>.m4a (or .wav, .aiff, .mp3) and that file is used in
 * place of the computer voice. See docs/video.md.
 *
 * The wording follows docs/video-script.md.
 */
export const NARRATION = {
  // 1. What this is
  "intro": "This is a policy administration platform for commercial insurance, with two roles. The broker issues policies, changes coverage, corrects mistakes, and cancels. The policyholder sees their coverage, pays, and reads their statement.",
  "intro-idea": "One idea runs through all of it: nothing on a statement is ever edited. Every action adds lines, and a mistake is fixed by reversing the wrong line and posting the right one, so every amount can be traced to the action and the payment behind it.",

  // 2. Issuing a policy
  "issue-form": "To issue a policy, the broker picks a start date and coverages. Prices are a flat annual rate per coverage, so ticking Cyber changes the total straight away.",
  "issue-signing": "The policyholder then signs the application through DocuSign's sandbox, inside the app, and only then can the broker issue.",
  "issue-signed": "Here's one that was signed earlier. The signed document, with DocuSign's certificate, stays linked to the policy.",

  // 3. The scenario: correcting the effective date
  "scenario-load": "Now the scenario from the brief. This button builds its starting point in one click.",
  "scenario-start": "A policy issued and paid six weeks ago, with Cyber added and paid three weeks ago. Both payments are real Stripe test payments. The yellow note says what was shortcut: no signature, and the history is backdated.",
  "scenario-statement": "The statement shows two charges and two payments, and nothing is due.",
  "scenario-calc": "Cyber was charged from its recorded start date to the end of the term: the annual premium, times the days covered, divided by the days in the term.",
  "correct-form": "Now the broker learns the coverage actually began a week earlier. They correct the date on the Cyber change and give a reason.",
  "correct-preview": "Before anything is saved, the preview shows exactly what will be posted: a reversal of the original charge, the new charge with seven more days, and the result, fourteen dollars more due. That's seven days at two dollars a day.",
  "correct-confirm": "Confirming posts it.",
  "correct-statement": "The original charge is still here, struck through and marked as superseded. Below it are the reversal and the corrected charge. Nothing was edited or deleted.",
  "correct-explained": "And the history entry explains the change in plain English.",

  // The policyholder's side, and a live Stripe payment
  "holder-sees": "The customer sees the same statement and the same explanation, right beside the button to pay the fourteen dollars.",
  "holder-pay": "They pay through Stripe in test mode, with Stripe's own card form.",
  "holder-paid": "The payment only reaches the statement once Stripe's servers confirm it, and each attempt is listed with its status and its Stripe reference.",

  // 4. Changing the date again: a refund
  "refund-form": "The date can be corrected as often as needed, and each correction starts from the current state. This time it moves two weeks later.",
  "refund-preview": "Now the customer has paid for days they don't get, so the preview shows a credit. When I confirm, the app refunds it to the original card through Stripe, without anyone clicking anything else.",
  "refund-done": "The refund is on the statement, linked to its Stripe record. Cancelling a policy works the same way: unused days are credited pro rata and refunded.",

  // 5. The integrations
  "integrations": "Both integrations are live sandboxes. This log is every request the app sent to Stripe and DocuSign, and every webhook it received back. The same payments and the signed envelope appear in Stripe's and DocuSign's own dashboards.",

  // 6. What's simulated and what's next
  "closing": "The insurer, pricing, and claim payments are simulated. The main thing I left out is installments, so that a policy has one balance and every amount stays easy to trace. Claims, renewals, and broker commissions are built as extensions. The decision log in the repo covers each choice.",
} as const;

export type BeatId = keyof typeof NARRATION;
