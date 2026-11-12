# Video script

A script for the submission video: up to five minutes, showing the transaction in the app. Timings are a guide and add up to about 4:40.

## Before recording

- Use the deployed app: https://policy-administration.vercel.app
- Open two browser windows side by side or in two tabs you can switch between: a normal window signed in as the **broker** (`broker@demo.test`), and a private window for the **policyholder**. Both use the password `demo-password`.
- Zoom the browser to about 110% so amounts are readable in the recording.
- Have Stripe's test card ready to paste: `4242 4242 4242 4242`, any future expiry, any CVC, any ZIP.
- Optional, for part 5: have the Stripe test dashboard (Payments) and the DocuSign sandbox (Completed envelopes) open in other tabs.
- Do one dry run first. The demo scenario can be loaded as many times as you like.

## 1. What this is (0:00 to 0:25)

**Show:** the broker's Customers page.

**Say:** "This is a policy administration platform for commercial insurance, with two roles. The broker issues policies, changes coverage, corrects mistakes, and cancels. The policyholder sees their coverage, pays, and reads their statement. One idea runs through all of it: nothing on a statement is ever edited. Every action adds lines, and a mistake is fixed by reversing the wrong line and posting the right one, so every amount can be traced to the action and the payment behind it."

## 2. Issuing and paying, the real flow (0:25 to 1:25)

**Show:** open **Acme Bakery LLC**. Scroll to **Start a new policy**, tick Cyber on and off to show the price change, then point at the **Applications** section and the already-issued policy.

**Say:** "To issue a policy, the broker picks a start date and coverages. Prices are a flat annual rate per coverage. The policyholder then signs the application through DocuSign's sandbox, inside the app, and only then can the broker issue."

**Show:** click into policy **SBP-2026-0002**. Point at "Application signed by Olive Owner … through DocuSign" and click **View signed application** to show the PDF briefly.

**Say:** "Here's one I signed earlier. The signed document, with DocuSign's certificate, stays linked to the policy."

**Show:** switch to the policyholder window, open the same policy, click **Pay now**, choose Card, enter the test card, and pay. Wait for the balance to reach $0.00 and point at the new payment line.

**Say:** "The policyholder pays through Stripe in test mode. The payment only reaches the statement once Stripe's servers confirm it, and each attempt is listed with its status and Stripe reference: pending, succeeded, or failed."

*If you're short on time, skip the live payment and just show the paid policy SBP-2026-0001 and its Payments and refunds table.*

## 3. The scenario: correcting the effective date (1:25 to 3:10)

**Show:** back in the broker window, go to Customers and click **Load demo scenario**. Wait for the policy page.

**Say:** "This is the scenario from the brief. This button builds the starting point in one click: a policy issued and paid six weeks ago, with Cyber added and paid three weeks ago. Both payments are real Stripe test payments. The yellow note says what was shortcut: no signature, and the history is backdated."

**Show:** the Statement: two charges, two payments, $0.00 balance. Open "How was this calculated?" on the Cyber line.

**Say:** "Cyber was charged from its recorded start date to the end of the term: the annual premium, times the days covered, divided by the days in the term."

**Show:** scroll to **Policy history**, click **Correct this** on entry #2, move the date one week earlier, type a reason, and click **Preview correction**. Pause on the preview.

**Say:** "Now the broker learns the coverage actually began a week earlier. Before anything is saved, the preview shows exactly what will be posted: a reversal of the original charge, the new charge with seven more days, and the result, fourteen dollars more due. That's seven days at two dollars a day."

**Show:** click **Confirm correction**. Scroll to the Statement.

**Say:** "The original charge is still here, struck through and marked as superseded. Below it are the reversal and the corrected charge. Nothing was edited or deleted. And the history entry explains the change in plain English."

**Show:** the "What this means" box on correction #3. Then switch to the policyholder window, sign in as the demo customer (the login is on the customer's page), and open the policy.

**Say:** "The customer sees the same statement and the same explanation, and can pay the fourteen dollars."

## 4. Changing the date again: a refund (3:10 to 3:55)

**Show:** in the broker window, click **Correct this** on the latest correction and move the date two weeks later. Preview, then confirm.

**Say:** "The date can be corrected as often as needed, and each correction starts from the current state. Moving it later means the customer has paid for days they don't get. The preview shows a credit, and when I confirm, the app refunds it to the original card through Stripe without anyone clicking anything else."

**Show:** the new Refund line on the statement and the refund row in **Payments and refunds**, marked Succeeded.

**Say:** "The refund is on the statement, linked to its Stripe record. Cancelling a policy works the same way: unused days are credited pro-rata and refunded."

## 5. The integrations (3:55 to 4:25)

**Show:** the broker's **Integration log** page. Then, if open, the Stripe test dashboard's Payments list and DocuSign's Completed envelopes.

**Say:** "Both integrations are live sandboxes. This log is every request the app sent to Stripe and DocuSign and every webhook it received back. The same payments and the signed envelope appear in Stripe's and DocuSign's own dashboards."

## 6. What's simulated and what's next (4:25 to 4:40)

**Show:** the README section "What we simplified", or stay on the app.

**Say:** "The insurer, pricing, and claim payments are simulated. The main thing I left out is installments, so that a policy has one balance and every amount stays easy to trace. Claims, renewals, and broker commissions are built as extensions. The decision log in the repo covers each choice."

## If something goes wrong while recording

- **The demo scenario button shows an error:** reload the page and click it again. It needs Stripe to be reachable.
- **A payment sits on pending for more than a few seconds:** reload the page. The app checks with Stripe again whenever the policy page opens.
- **You want a clean take:** load another demo scenario. Each one is a new customer with its own policy.
