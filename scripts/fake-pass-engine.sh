#!/bin/sh
sleep "${MC_FAKE_STEP_SECONDS:-4}"
printf '%s\n' '{"type":"result","result":"MC_RESULT {\"outcome\":\"pass\",\"summary\":\"Fake step passed\",\"evidence\":[\"fake engine\"]}"}'
