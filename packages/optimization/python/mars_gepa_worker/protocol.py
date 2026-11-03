"""Newline-delimited JSON channel plus a request/reply broker."""

from __future__ import annotations

import json
from typing import Any, TextIO


class ProtocolError(Exception):
    """The host sent something the worker cannot interpret."""


class HostAbort(Exception):
    """The host declined a request (budget, deadline or cancel); stop quietly."""


class Channel:
    def __init__(self, reader: TextIO, writer: TextIO) -> None:
        self._reader = reader
        self._writer = writer

    def send(self, message: dict[str, Any]) -> None:
        self._writer.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
        self._writer.flush()

    def receive(self) -> dict[str, Any]:
        line = self._reader.readline()
        if not line:
            raise ProtocolError("host closed the channel")
        try:
            message = json.loads(line)
        except json.JSONDecodeError as error:
            raise ProtocolError(f"invalid JSON from host: {error.msg}") from None
        if not isinstance(message, dict) or not isinstance(message.get("type"), str):
            raise ProtocolError("host message must be an object with a string 'type'")
        return message


class Broker:
    """Correlates outgoing requests with incoming replies by integer id."""

    def __init__(self, channel: Channel) -> None:
        self._channel = channel
        self._next_id = 0

    def request(self, message: dict[str, Any], expect: str) -> dict[str, Any]:
        return self.request_many([message], expect)[0]

    def request_many(self, messages: list[dict[str, Any]], expect: str) -> list[dict[str, Any]]:
        ids: list[int] = []
        for message in messages:
            request_id = self._next_id
            self._next_id += 1
            ids.append(request_id)
            self._channel.send({**message, "id": request_id})
        pending = set(ids)
        replies: dict[int, dict[str, Any]] = {}
        while pending:
            reply = self._channel.receive()
            reply_id = reply.get("id")
            if reply.get("type") == "abort":
                raise HostAbort(str(reply.get("message", "aborted by host")))
            if not isinstance(reply_id, int) or reply_id not in pending:
                raise ProtocolError(f"unexpected reply id {reply_id!r}")
            if reply.get("type") != expect:
                raise ProtocolError(f"expected {expect}, got {reply.get('type')!r}")
            pending.remove(reply_id)
            replies[reply_id] = reply
        return [replies[request_id] for request_id in ids]
