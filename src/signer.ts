import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { SignerError } from "./errors.js";

/**
 * Anything that can sign a transaction. A wallet adapter fits this shape:
 * pass the account's address as `publicKey` and wrap the wallet's sign call.
 */
export interface Signer {
  /** The account that signs and pays for transactions (a `G...` address). */
  publicKey: string;
  /** Sign a transaction given as base64 XDR and return the signed XDR. */
  signTransaction(xdr: string, opts: { networkPassphrase: string }): Promise<string>;
}

/** A signer backed by a secret key. For servers, scripts and tests, not browsers. */
export function keypairSigner(keypair: Keypair | string): Signer {
  const kp = typeof keypair === "string" ? Keypair.fromSecret(keypair) : keypair;
  return {
    publicKey: kp.publicKey(),
    async signTransaction(xdr, { networkPassphrase }) {
      try {
        const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
        tx.sign(kp);
        return tx.toXDR();
      } catch (cause) {
        throw new SignerError("Could not sign the transaction.", { cause });
      }
    },
  };
}

// TODO(wave: sdk-1): wallet adapters (Freighter, xBull, Albedo, Lobstr and others) that return a Signer,
// so apps do not each wrap a wallet's sign call by hand.
