#!/usr/bin/env bash
# Makes `git push` run tools/check.sh first and refuse to push when it fails.
cd "$(dirname "$0")/.."
cat > .git/hooks/pre-push <<'HOOK'
#!/usr/bin/env bash
# CrewMon: run the checks on what is about to be pushed
while read -r local_ref local_sha remote_ref remote_sha; do
  if [ "$remote_sha" = "0000000000000000000000000000000000000000" ]; then range=""; else range="$remote_sha..$local_sha"; fi
  tools/check.sh "$range" || { echo "pre-push: checks failed, nothing was pushed (tools/check.sh)"; exit 1; }
done
HOOK
chmod +x .git/hooks/pre-push
echo "pre-push hook installed: git push now runs tools/check.sh"
