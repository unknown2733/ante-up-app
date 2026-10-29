#!/usr/bin/env bash
set -euo pipefail
release=/srv/ante-up/builds/youtube-live-cadence-20261030
units=/home/user/.config/systemd/user
timer=ante-up-reference-youtube.timer
service=ante-up-reference-youtube.service
dropin="$units/$service.d/oracle-prep.conf"
backup="$release/timer.before"
[[ -f "$units/$timer" && -f "$release/$timer" && -f "$release/ante-up-reference-youtube-oracle-prep.conf" ]] ||
  { echo YOUTUBE_ROLLOUT_INPUT_MISSING; exit 2; }
[[ ! -e "$dropin" ]] || { echo YOUTUBE_ROLLOUT_ALREADY_APPLIED; exit 2; }
if [[ -e "$backup" ]]; then
  cmp -s -- "$units/$timer" "$backup" || { echo YOUTUBE_TIMER_BACKUP_MISMATCH; exit 2; }
else
  cp -p -- "$units/$timer" "$backup"
fi
rollback(){
  echo YOUTUBE_ROLLOUT_ROLLBACK
  cp -p -- "$backup" "$units/$timer"
  rm -f -- "$dropin"
  systemctl --user daemon-reload
  systemctl --user start "$timer"
}
trap rollback ERR
systemctl --user stop "$timer"
mkdir -p -- "$units/$service.d"
cp -p -- "$release/$timer" "$units/$timer"
cp -p -- "$release/ante-up-reference-youtube-oracle-prep.conf" "$dropin"
systemctl --user daemon-reload
systemctl --user start "$service"
[[ "$(systemctl --user show "$service" -p Result --value)" == success ]]
systemctl --user start "$timer"
systemctl --user is-active --quiet "$timer"
trap - ERR
echo YOUTUBE_ORACLE_PREP_ACTIVE
