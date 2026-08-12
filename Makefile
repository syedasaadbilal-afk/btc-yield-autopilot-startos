ARCHES := x86 arm
# overrides to s9pk.mk must precede the include statement

# start-cli s9pk pack embeds whatever's in the LOCAL docker image cache for
# the manifest's dockerTag - it does NOT pull fresh from the registry. If a
# stale local image is cached under the same tag (e.g. from an earlier dev
# session), packing silently ships the OLD code even after a real GHCR push
# and a green Actions build. `make deploy` forces a clean pull every time so
# this can't happen again - always use it instead of `make arch/x86_64`
# directly for real releases.
IMAGE := ghcr.io/syedasaadbilal-afk/btc-yield-autopilot-startos:latest

.PHONY: pull-image deploy

pull-image:
	@echo "Removing any locally cached image to force a fresh pull..."
	-docker rmi -f $(IMAGE) 2>/dev/null
	docker pull $(IMAGE)
	@# Bug found live Aug 2026: s9pk.mk's packing rule only reruns when local
	@# source files or .git/HEAD/.index are newer than the existing .s9pk -
	@# it has no idea the *remote* image we just pulled changed, so a stale
	@# .s9pk built from an old cached image gets silently reused (still
	@# prints "Build Complete" with the current git hash, since that comes
	@# from local git state, not from what's actually baked into the image).
	@# Deleting any existing .s9pk here guarantees the next pack step has no
	@# choice but to actually run, every single time.
	@echo "Removing any existing .s9pk so the next pack step is forced to rebuild..."
	-rm -f $(PACKAGE_ID)*.s9pk

deploy: pull-image arch/x86_64 install
	@echo "Deploy complete - fresh image pulled, packed, and installed."

include s9pk.mk
