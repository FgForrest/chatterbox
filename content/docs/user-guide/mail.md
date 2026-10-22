---
title: Mail
description: Sending mail into your Chatter pile.
---

When your administrator has set it up, mail can join your recordings. Mail sent to your addresses lands in your **Chatter** pile, encrypted, beside your recordings. The type filter above the list shows **All**, **Audio** or **Mail**.

Mail needs single sign-on: you get addresses once you sign in with your organization's account. They pause if you have not signed in that way for a long time, and resume at your next sign-in.

## Your addresses

**Settings → Mail** lists them.

- Your **mailbox** (`zorven@…`) puts mail in your pile, unfiled. Its workflow strip starts with **Receive** as **Done** and **Categorize** as **Next**. The inline **Categorize email** card asks for **Folder** and **Profile**, or **Nothing automatic**. No paid AI step runs until you click **Categorize email**.
- Every folder has an address (`zorven+weekly@…`) that files mail straight into it. The mail skips the wait and uses the folder's default mail profile.

Only mail you send yourself, from the account you sign in with, is accepted on these addresses: forward a mail to one, or put it in **To**, **Cc** or **Bcc** when you write. Chatterbox checks the mail's signature, so nobody can send in your name.

## Folder addresses

Open **Folder settings** from the folder name or **⋯** to see its addresses under **Mail to folder**, with a copy button and the time of the last mail. Copy the current address, or give the folder an address of your own: the old one keeps working as a secondary address until you remove it. An address that was ever given out is never given to anyone else. Mail to any of these addresses is filed and can start the profile automatically.

Deleting a folder stops its addresses, and its subfolders', for good. Chatterbox shows when each last received mail before you confirm.

## Organization folders

Organization folders have addresses that start with the organization's name (`acme-weekly@…`). Any colleague may send to them, in **To** or **Cc** (not **Bcc**). The mail stays private at first, with that folder as its intended Organization placement. Its Organization profile runs in the private view, and Chatterbox shares the mail automatically after its Learn and task reviews pass. With **Nothing automatic**, the folder row offers **Share now** instead and the workflow strip waits for you.

You can also share any of your mail by filing it into an Organization folder. Colleagues read a shared mail, its attachments and its formatted version; only you delete it or download the original message.

## Secret addresses

For mail you do not send yourself, create a **secret address** in **Settings → Mail**. It extends your mailbox or a folder address with a random part (`zorven.k3x9…@…`) and files mail the same way, from any sender. A secret address extending the mailbox leaves mail waiting for filing; one extending a folder skips the wait. Anyone who knows it can send to it, so give it a name you recognize, and **replace** or **stop** it when it leaks.

### Gmail filters and automatic forwarding

Automatic forwarding keeps the original sender, so it needs a secret address.

1. Create a secret address and copy it.
2. In Gmail, open **Settings → Forwarding and POP/IMAP → Add a forwarding address** and enter it.
3. Gmail sends a confirmation code to the address. It arrives in your Chatter pile as a mail from Google: open it and enter the code in Gmail.
4. Create a Gmail filter whose action forwards to that address.

## Reading mail

A mail shows who sent it, with **Verified** when the sender's domain signed it, the recipients and the date. Quoted and forwarded messages are folded under their author. **Show formatted** shows the mail as it was designed, with nothing loaded from the internet. Attachments download only.

Search in Chatter also finds words in forwarded and quoted messages. Signatures and disclaimers are not searched.

As processing advances, the Learn review, **Summary**, and **Task review** widgets appear inline in that order. Finished widgets fold to one line while work continues. A step you start yourself after the workflow shows its running state in place; review windows open only when you click **Review** or **View results**.

Mail sent by machines (auto-replies, mailing lists, notices) is kept but marked **Not processed**. No AI step runs for it.

## The delivery log

**Settings → Mail → Delivery log** lists what became of mail sent to your addresses in the last 30 days: received, already received, or refused and why. Refused mail is not kept.

Next: [Exports, backups and retention](exports-backups-retention.md)
