import type { Session, WebFrameMain } from "electron";
import { BrowserWindow, dialog, webContents as electronWebContents } from "electron";
import { msg } from "gt-i18n";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { m } from "../i18n/messages.ts";

export class PreviewPasskeys extends Context.Service<
  PreviewPasskeys,
  {
    readonly installSessionHandlers: (session: Session) => void;
  }
>()("@t3tools/desktop/preview/Passkeys/PreviewPasskeys") {}

const accountLabel = (account: Electron.WebAuthnAccount) =>
  account.displayName && account.name && account.displayName !== account.name
    ? `${account.displayName} (${account.name})`
    : (account.name ?? account.displayName ?? m(msg("Unnamed passkey")));

const ownerWindow = (frame: WebFrameMain | null) => {
  const contents = frame ? electronWebContents.fromFrame(frame) : undefined;
  const owner = contents?.hostWebContents ?? contents;
  return owner ? BrowserWindow.fromWebContents(owner) : null;
};

const chooseAccount = async (details: Electron.SelectWebauthnAccountDetails) => {
  const [onlyAccount] = details.accounts;
  if (details.accounts.length === 1) return onlyAccount?.credentialId;
  const options: Electron.MessageBoxOptions = {
    type: "none",
    message: m(msg("Choose a passkey")),
    detail: details.relyingPartyId,
    buttons: [...details.accounts.map(accountLabel), m(msg("Cancel"))],
    cancelId: details.accounts.length,
    defaultId: 0,
    noLink: true,
  };
  const parent = ownerWindow(details.frame);
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return details.accounts[response]?.credentialId;
};

const make = Effect.sync(() => {
  const sessionsWithHandlers = new WeakSet<Session>();

  return PreviewPasskeys.of({
    installSessionHandlers: (session) => {
      if (sessionsWithHandlers.has(session)) return;
      sessionsWithHandlers.add(session);
      session.on("select-webauthn-account", (_event, details, callback) => {
        // The request stays pending until the callback runs, so it must run once.
        void chooseAccount(details).then(
          (credentialId) => callback(credentialId),
          () => callback(),
        );
      });
    },
  });
}).pipe(Effect.withSpan("PreviewPasskeys.make"));

export const layer = Layer.effect(PreviewPasskeys, make);
