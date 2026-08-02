#!/usr/bin/env python3
"""Throwaway terminal shell for the Source Space model prototype."""

from __future__ import annotations

import json
import os

from model import (
    full_debug_state,
    initial_state,
    inject_mount_collision,
    inject_object_leak,
    land,
    project_view,
    visible_profiles,
)


BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"


def render(state: dict, actor: str, profile: str) -> None:
    os.system("clear")
    actor_state = state["actors"][actor]
    print(f"{BOLD}PROTOTYPE — Source Space state model{RESET}")
    print(
        f"{DIM}Selected actor:{RESET} {actor_state['label']}  "
        f"{DIM}requested profile:{RESET} {profile}"
    )
    print(
        f"{DIM}Discoverable profiles:{RESET} "
        f"{', '.join(visible_profiles(state, actor)) or '(none)'}"
    )
    print()
    print(f"{BOLD}Internal authority (debug view only){RESET}")
    print(json.dumps(full_debug_state(state), indent=2, sort_keys=True))
    print()
    print(f"{BOLD}Actor-visible Project View{RESET}")
    print(json.dumps(project_view(state, actor, profile), indent=2, sort_keys=True))
    print()
    print(f"{BOLD}Actions{RESET}")
    print("[1] visitor  [2] developer  [3] external agent  [4] enterprise agent")
    print("[c] community profile  [m] commercial profile  [s] security profile")
    print("[p] public Landing  [r] private Landing  [x] cross-space Landing")
    print("[g] inject Git-object leak  [o] inject mount overlap  [z] reset")
    print("[q] quit")


def next_snapshot(current: str) -> str:
    prefix, value = current.split(":", 1)
    letter = value[0]
    number = int(value[1:]) + 1
    return f"{prefix}:{letter}{number}"


def main() -> None:
    state = initial_state()
    actor = "visitor"
    profile = "community"
    while True:
        render(state, actor, profile)
        command = input("\n> ").strip().lower()
        if command == "q":
            return
        if command in {"1", "2", "3", "4"}:
            actor = {
                "1": "visitor",
                "2": "developer",
                "3": "external-agent",
                "4": "enterprise-agent",
            }[command]
        elif command in {"c", "m", "s"}:
            profile = {"c": "community", "m": "commercial", "s": "security"}[
                command
            ]
        elif command == "p":
            state = land(
                state,
                {"player": next_snapshot(state["spaces"]["player"]["snapshot"])},
                "public",
            )
        elif command == "r":
            state = land(
                state,
                {
                    "commercial-codec": next_snapshot(
                        state["spaces"]["commercial-codec"]["snapshot"]
                    )
                },
                "private",
            )
        elif command == "x":
            state = land(
                state,
                {
                    key: next_snapshot(state["spaces"][key]["snapshot"])
                    for key in state["spaces"]
                },
                "cross-space",
            )
        elif command == "g":
            state = inject_object_leak(state)
        elif command == "o":
            state = inject_mount_collision(state)
        elif command == "z":
            state = initial_state()


if __name__ == "__main__":
    main()
