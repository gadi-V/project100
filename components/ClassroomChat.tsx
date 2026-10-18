"use client";

import { useEffect, useState } from "react";
import {
  StreamChat,
  Channel as StreamChannelType,
  type Message,
} from "stream-chat";
import {
  Chat,
  Channel,
  ChannelHeader,
  MessageList,
  MessageComposer,
  Thread,
  Window,
} from "stream-chat-react";
import "stream-chat-react/dist/css/index.css";
import { censorChatText } from "../lib/chat-moderation";

const ACCEPTED_CHAT_FILES = [
  "image/*",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

const CHAT_UNAVAILABLE_MESSAGE =
  "הצ'אט אינו זמין כרגע. אנא רענן את העמוד או פנה לתמיכה.";

/**
 * Server mock tokens (`mock-stream-token-…`) and blank strings are not JWTs.
 * Sending them makes Stream throw "User token can not be empty" or
 * "userToken does not have a user_id". A real token is three base64url segments
 * and does not use the mock prefix (the signature can coincidentally contain
 * the letters "mock", so the check is the prefix, not a substring of the JWT).
 */
function isUsableStreamUserToken(token: string): boolean {
  const value = token.trim();
  if (!value || value.toLowerCase().startsWith("mock")) return false;
  return value.split(".").length === 3;
}

function ChatUnavailable() {
  return (
    <div
      className="flex h-full min-h-[200px] items-center justify-center bg-white/80 backdrop-blur-md border border-neutral-200/80 rounded-2xl px-4"
      role="status"
      aria-disabled="true"
    >
      <span className="text-neutral-600 font-medium text-sm text-center">
        {CHAT_UNAVAILABLE_MESSAGE}
      </span>
    </div>
  );
}

export type ClassroomChatProps = {
  apiKey: string;
  userToken: string;
  userId: string;
  firstName: string;
  channelId: string;
  /** Optional: unified package channel label. */
  packageId?: string | null;
  /** Optional: expose the watched Stream channel for whiteboard live sync. */
  onChannelReady?: (channel: StreamChannelType | null) => void;
};

export default function ClassroomChat({
  apiKey,
  userToken,
  userId,
  firstName,
  channelId,
  packageId,
  onChannelReady,
}: ClassroomChatProps) {
  const [client, setClient] = useState<StreamChat | null>(null);
  const [channel, setChannel] = useState<StreamChannelType | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const chatTitle = packageId ? "צ'אט כיתה · חומרי חבילה" : "צ'אט כיתה חכם";
  const streamUserId = typeof userId === "string" ? userId.trim() : "";
  const streamFirstName = typeof firstName === "string" ? firstName.trim() : "";
  const identityReady = Boolean(streamUserId && streamFirstName);
  const credentialsReady =
    Boolean(apiKey && channelId) && identityReady && isUsableStreamUserToken(userToken ?? "");

  useEffect(() => {
    // Props can arrive a render late. Connecting before id/name exist makes
    // the websocket open with user_details omitted (close code 4).
    if (!identityReady) return;

    let cancelled = false;

    if (!credentialsReady) {
      setUnavailable(true);
      setClient(null);
      setChannel(null);
      onChannelReady?.(null);
      return;
    }

    // Own client per mount. getInstance() is a singleton: StrictMode cleanup
    // calls disconnectUser(), which wipes the token and the remount then throws
    // "Both secret and user tokens are not set".
    const chatClient = new StreamChat(apiKey);
    const streamUser = {
      id: streamUserId,
      name: `${streamFirstName} (${streamUserId.slice(0, 4)})`,
    };

    const connectionPromise = chatClient.connectUser(streamUser, userToken);

    const initChat = async () => {
      try {
        setUnavailable(false);
        await connectionPromise;
        if (cancelled) return;

        const ch = chatClient.channel("messaging", channelId);
        await ch.watch();

        if (cancelled) return;

        const attachmentManager = ch.messageComposer?.attachmentManager;
        if (attachmentManager) {
          attachmentManager.acceptedFiles = ACCEPTED_CHAT_FILES;
        }

        setClient(chatClient);
        setChannel(ch);
        onChannelReady?.(ch);
      } catch (err) {
        console.error("Stream Chat connection error:", err);
        if (!cancelled) {
          setUnavailable(true);
          setClient(null);
          setChannel(null);
          onChannelReady?.(null);
        }
      }
    };

    void initChat();

    return () => {
      cancelled = true;
      onChannelReady?.(null);
      // disconnectUser() deletes _user immediately. Waiting until connectUser
      // settles keeps user_details on the socket that is already opening.
      void connectionPromise
        .catch(() => undefined)
        .then(() => chatClient.disconnectUser())
        .catch(() => undefined);
    };
  }, [
    apiKey,
    userToken,
    streamUserId,
    streamFirstName,
    channelId,
    onChannelReady,
    credentialsReady,
    identityReady,
  ]);

  if (!identityReady) {
    return (
      <div className="flex h-full min-h-[200px] items-center justify-center bg-white/80 backdrop-blur-md border border-neutral-200/80 rounded-2xl">
        <span className="text-neutral-500 font-medium text-sm animate-pulse">
          מתחבר לערוץ התקשורת המאובטח...
        </span>
      </div>
    );
  }

  if (!credentialsReady || unavailable) {
    return <ChatUnavailable />;
  }

  if (!client || !channel) {
    return (
      <div className="flex h-full min-h-[200px] items-center justify-center bg-white/80 backdrop-blur-md border border-neutral-200/80 rounded-2xl">
        <span className="text-neutral-500 font-medium text-sm animate-pulse">
          מתחבר לערוץ התקשורת המאובטח...
        </span>
      </div>
    );
  }

  return (
    <div className="h-full min-h-[200px] w-full border border-neutral-200/80 rounded-2xl overflow-hidden shadow-sm bg-white/80 backdrop-blur-md">
      <Chat client={client} theme="messaging light">
        <Channel
          channel={channel}
          doSendMessageRequest={async (activeChannel, message) => {
            const payload: Message = { ...message };
            if (payload.text) {
              payload.text = censorChatText(payload.text);
            }
            return activeChannel.sendMessage(payload);
          }}
        >
          <Window>
            <ChannelHeader title={chatTitle} />
            <MessageList />
            <MessageComposer focus />
          </Window>
          <Thread />
        </Channel>
      </Chat>
    </div>
  );
}
