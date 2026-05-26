/**
 * ChatTranscript — 消息列表渲染
 *
 * 参考 openhanako 的 ChatTranscript，遍历消息数组
 * 按类型渲染 UserMessage 或 AssistantMessage。
 */

import { memo, useMemo } from 'react';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';

export const ChatTranscript = memo(function ChatTranscript({
  messages,
  sessionId,
}) {
  const latestTurn = useMemo(() => {
    let latestUserIdx = -1;
    let latestAssistantIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (latestUserIdx < 0 && msg.role === 'user') latestUserIdx = i;
      if (latestAssistantIdx < 0 && msg.role === 'assistant') latestAssistantIdx = i;
      if (latestUserIdx >= 0 && latestAssistantIdx >= 0) break;
    }
    return {
      latestUserIdx,
      latestAssistantIdx,
      latestUserMessage: latestUserIdx >= 0 ? messages[latestUserIdx] : null,
    };
  }, [messages]);

  return (
    <>
      {messages.map((msg, index) => (
        <TranscriptItem
          key={msg.id || `msg-${index}`}
          message={msg}
          prevMessage={index > 0 ? messages[index - 1] : null}
          sessionId={sessionId}
          isLatestUser={index === latestTurn.latestUserIdx}
          isLatestAssistant={index === latestTurn.latestAssistantIdx && latestTurn.latestAssistantIdx > latestTurn.latestUserIdx}
          retrySource={latestTurn.latestUserMessage}
        />
      ))}
    </>
  );
});

const TranscriptItem = memo(function TranscriptItem({
  message,
  prevMessage,
  sessionId,
  isLatestUser,
  isLatestAssistant,
  retrySource,
}) {
  const prevRole = prevMessage?.role || null;
  const showAvatar = message.role !== prevRole;

  if (message.role === 'user') {
    return (
      <UserMessage
        message={message}
        showAvatar={showAvatar}
        isLatest={isLatestUser}
      />
    );
  }

  return (
    <AssistantMessage
      message={message}
      showAvatar={showAvatar}
      sessionId={sessionId}
      isLatest={isLatestAssistant}
      retrySource={retrySource}
    />
  );
});
