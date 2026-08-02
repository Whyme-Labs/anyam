"""Pure state and projection logic for the throwaway Source Space prototype."""

from __future__ import annotations

from copy import deepcopy
from hashlib import sha256
import json


def _digest(prefix: str, value: object) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return f"{prefix}:{sha256(encoded).hexdigest()[:12]}"


def initial_state() -> dict:
    state = {
        "project": "loom-player",
        "schema": 1,
        "spaces": {
            "player": {
                "internal_id": "space_01J_PLAYER",
                "label": "player",
                "access": "public",
                "license": "Apache-2.0",
                "snapshot": "git:p1",
                "model_policy": ["external", "enterprise", "local"],
                "git_references": [],
                "outbound_dependencies": ["codec-contracts"],
            },
            "codec-contracts": {
                "internal_id": "space_01J_CONTRACTS",
                "label": "codec-contracts",
                "access": "public",
                "license": "Apache-2.0",
                "snapshot": "git:a1",
                "model_policy": ["external", "enterprise", "local"],
                "git_references": [],
                "outbound_dependencies": [],
            },
            "commercial-codec": {
                "internal_id": "space_01J_COMMERCIAL",
                "label": "commercial-codec",
                "access": "private",
                "license": "Proprietary",
                "snapshot": "git:c1",
                "model_policy": ["enterprise", "local"],
                "git_references": [],
                "outbound_dependencies": ["codec-contracts"],
            },
            "compatibility-lab": {
                "internal_id": "space_01J_LAB",
                "label": "compatibility-lab",
                "access": "restricted",
                "license": "Proprietary",
                "snapshot": "git:t1",
                "model_policy": ["local"],
                "git_references": [],
                "outbound_dependencies": [
                    "player",
                    "codec-contracts",
                    "commercial-codec",
                ],
            },
        },
        "profiles": {
            "community": {
                "version": 1,
                "spaces": ["player", "codec-contracts"],
                "mounts": {
                    "player": "player",
                    "codec-contracts": "packages/codec-contracts",
                },
                "declared_external_dependencies": [],
                "asserted_build_result": None,
            },
            "commercial": {
                "version": 1,
                "spaces": ["player", "codec-contracts", "commercial-codec"],
                "mounts": {
                    "player": "player",
                    "codec-contracts": "packages/codec-contracts",
                    "commercial-codec": "codecs/commercial",
                },
                "declared_external_dependencies": [],
                "asserted_build_result": "passing",
            },
            "security": {
                "version": 1,
                "spaces": [
                    "player",
                    "codec-contracts",
                    "commercial-codec",
                    "compatibility-lab",
                ],
                "mounts": {
                    "player": "player",
                    "codec-contracts": "packages/codec-contracts",
                    "commercial-codec": "codecs/commercial",
                    "compatibility-lab": "verification/compatibility-lab",
                },
                "declared_external_dependencies": [],
                "asserted_build_result": "passing",
            },
        },
        "actors": {
            "visitor": {
                "label": "anonymous public visitor",
                "kind": "human",
                "readable_spaces": ["player", "codec-contracts"],
                "model": None,
                "inspect_full_revision": False,
            },
            "developer": {
                "label": "internal developer",
                "kind": "human",
                "readable_spaces": [
                    "player",
                    "codec-contracts",
                    "commercial-codec",
                    "compatibility-lab",
                ],
                "model": None,
                "inspect_full_revision": True,
            },
            "external-agent": {
                "label": "external coding agent",
                "kind": "agent",
                "readable_spaces": ["player", "codec-contracts"],
                "model": "external",
                "inspect_full_revision": False,
            },
            "enterprise-agent": {
                "label": "enterprise coding agent",
                "kind": "agent",
                "readable_spaces": [
                    "player",
                    "codec-contracts",
                    "commercial-codec",
                    "compatibility-lab",
                ],
                "model": "enterprise",
                "inspect_full_revision": False,
            },
        },
        "parent_revision": None,
        "events": [],
        "last_action": "initialized hybrid-source video player",
    }
    state["canonical_revision"] = canonical_revision(state)
    return state


def canonical_revision(state: dict) -> str:
    manifest = {
        "project": state["project"],
        "schema": state["schema"],
        "parent": state.get("parent_revision"),
        "snapshots": {
            value["internal_id"]: value["snapshot"]
            for value in state["spaces"].values()
        },
    }
    return _digest("project", manifest)


def _eligible(state: dict, actor_key: str, space_key: str) -> bool:
    actor = state["actors"][actor_key]
    space = state["spaces"][space_key]
    if space_key not in actor["readable_spaces"]:
        return False
    if actor["kind"] == "agent" and actor["model"] not in space["model_policy"]:
        return False
    return True


def visible_profiles(state: dict, actor_key: str) -> list[str]:
    return [
        key
        for key, profile in state["profiles"].items()
        if all(_eligible(state, actor_key, space) for space in profile["spaces"])
    ]


def validate_profile(state: dict, profile_key: str) -> list[str]:
    profile = state["profiles"][profile_key]
    failures: list[str] = []
    mounts = profile["mounts"]

    normalized = {space: path.strip("/") for space, path in mounts.items()}
    entries = list(normalized.items())
    for index, (left_space, left_path) in enumerate(entries):
        for right_space, right_path in entries[index + 1 :]:
            if (
                left_path == right_path
                or left_path.startswith(right_path + "/")
                or right_path.startswith(left_path + "/")
            ):
                failures.append(
                    f"mount collision: {left_space}@{left_path} overlaps "
                    f"{right_space}@{right_path}"
                )

    included = set(profile["spaces"])
    declared_external = set(profile["declared_external_dependencies"])
    for space_key in profile["spaces"]:
        space = state["spaces"][space_key]
        for reference in space["git_references"]:
            if reference != space_key:
                failures.append(
                    f"object-graph leak: {space_key} Git history reaches {reference}"
                )
        for dependency in space["outbound_dependencies"]:
            if dependency not in included and dependency not in declared_external:
                failures.append(
                    f"disclosure leak: {space_key} names hidden dependency {dependency}"
                )
    return failures


def _safe_events(state: dict, visible_spaces: set[str]) -> list[dict]:
    projected = []
    for event in state["events"]:
        disclosed_changes = {
            space: snapshot
            for space, snapshot in event["changed_spaces"].items()
            if space in visible_spaces
        }
        if not disclosed_changes:
            continue
        public_summary = event["public_summary"]
        projected.append(
            {
                "change": _digest(
                    "change-view",
                    {"summary": public_summary, "changed_spaces": disclosed_changes},
                ),
                "summary": public_summary,
                "changed_spaces": disclosed_changes,
            }
        )
    return projected


def project_view(state: dict, actor_key: str, profile_key: str) -> dict:
    if profile_key not in visible_profiles(state, actor_key):
        return {"error": "not_found"}

    failures = validate_profile(state, profile_key)
    if failures:
        return {"error": "unsafe_projection", "failures": failures}

    profile = state["profiles"][profile_key]
    visible_spaces = set(profile["spaces"])
    disclosed_spaces = [
        {
            "handle": key,
            "mount": profile["mounts"][key],
            "snapshot": state["spaces"][key]["snapshot"],
            "license": state["spaces"][key]["license"],
        }
        for key in sorted(profile["spaces"])
    ]
    revision_inputs = {
        "schema": 1,
        "profile": profile_key,
        "profile_version": profile["version"],
        "spaces": disclosed_spaces,
    }
    actor = state["actors"][actor_key]
    result = {
        "project": state["project"],
        "profile": profile_key,
        "view_revision": _digest("view", revision_inputs),
        "source_spaces": disclosed_spaces,
        "asserted_build_result": profile["asserted_build_result"],
        "activity": _safe_events(state, visible_spaces),
    }
    if actor["inspect_full_revision"]:
        result["canonical_project_revision"] = state["canonical_revision"]
    return result


def land(state: dict, changed_spaces: dict[str, str], kind: str) -> dict:
    next_state = deepcopy(state)
    next_state["parent_revision"] = state["canonical_revision"]
    for space_key, snapshot in changed_spaces.items():
        next_state["spaces"][space_key]["snapshot"] = snapshot
    next_state["canonical_revision"] = canonical_revision(next_state)
    next_state["events"].append(
        {
            "change": f"change-{len(next_state['events']) + 1}",
            "kind": kind,
            "public_summary": {
                "public": "update player source",
                "private": "internal implementation update",
                "cross-space": "extend codec contract",
            }[kind],
            "changed_spaces": dict(changed_spaces),
        }
    )
    next_state["last_action"] = f"landed {kind} Change"
    return next_state


def inject_object_leak(state: dict) -> dict:
    next_state = deepcopy(state)
    next_state["spaces"]["player"]["git_references"] = ["commercial-codec"]
    next_state["last_action"] = "injected public Git reachability to private source"
    return next_state


def inject_mount_collision(state: dict) -> dict:
    next_state = deepcopy(state)
    next_state["profiles"]["community"]["mounts"]["codec-contracts"] = "player"
    next_state["last_action"] = "injected overlapping community mounts"
    return next_state


def full_debug_state(state: dict) -> dict:
    return {
        "canonical_project_revision": state["canonical_revision"],
        "parent_project_revision": state["parent_revision"],
        "snapshots": {
            key: value["snapshot"] for key, value in state["spaces"].items()
        },
        "profile_validation": {
            key: validate_profile(state, key) for key in state["profiles"]
        },
        "event_count": len(state["events"]),
        "last_action": state["last_action"],
    }
