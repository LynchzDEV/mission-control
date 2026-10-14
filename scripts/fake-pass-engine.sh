#!/bin/sh
# ponytail: legacy MC_FAKE_STEP_SECONDS, drop once every install runs Shikidan
sleep "${SKD_FAKE_STEP_SECONDS:-${MC_FAKE_STEP_SECONDS:-4}}"
printf '%s\n' '{"type":"result","result":"MC_RESULT {\"outcome\":\"pass\",\"summary\":\"Fake step passed\",\"evidence\":[\"fake engine\"]}"}'
