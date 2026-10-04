"use client";
import Image from "next/image";
import {
  Moon,
  FilePenLine,
  Search,
  ShieldCheck,
  Info,
  ArrowRight,
} from "lucide-react";
import { Modal } from "./modal";
export function Welcome({
  close,
  ready,
  continueToAuthorization,
}: {
  close: () => void;
  ready: boolean;
  continueToAuthorization: () => void;
}) {
  return (
    <Modal title="Welcome to MirrorPick" close={close}>
      <div className="mp-welcome">
        <div className="mp-brand">
          MirrorPick <Moon fill="currentColor" />
        </div>
        <Image
          width={349}
          height={255}
          loading="eager"
          src="/mirrorpick/welcome-scene.png"
          alt="Skincare decoration"
        />
        <h2>
          Let MirrorPick
          <br />
          shop skincare for you.
        </h2>
        <p>
          An automated skincare shopping assistant
          <br />
          for Hong Kong university students.
        </p>
        <ol>
          {[
            [
              FilePenLine,
              "Set preferences & authorize",
              "Tell us your needs, budget and purchase range.",
            ],
            [
              Search,
              "Search & recommend",
              "Compare source-backed candidates and unknown facts.",
            ],
            [
              ShieldCheck,
              "Purchase after risk checks",
              "Explicit sandbox permission is required before execution.",
            ],
          ].map(([Icon, title, text], i) => {
            const I = Icon as typeof Search;
            return (
              <li key={i}>
                <span>0{i + 1}</span>
                <I />
                <div>
                  <h3>{String(title)}</h3>
                  <p>{String(text)}</p>
                </div>
              </li>
            );
          })}
        </ol>
        <div className="mp-note">
          <Info size={18} />
          You can revoke authorization at any time. Submitted payments may still
          settle.
        </div>
        <p className="mp-center">
          Continue to authorization, or close to search without it.
        </p>
        <button
          className="primary"
          disabled={!ready}
          onClick={continueToAuthorization}
        >
          Continue <ArrowRight />
        </button>
      </div>
    </Modal>
  );
}
