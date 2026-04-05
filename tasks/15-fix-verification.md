# Task 15: Fix Verification Fails with B2 Application Keys

## Problem

Upload works but verification fails with error:
```
you must use bucket(s) [{"9b2c1544e5005ea49bd80818" "khld-audiobooks"}] with this application key
```

The same remote works in CLI (`rclone ls remote:khld-audiobooks`) but fails in the RC API when called from the app.

## Symptoms

- `rclone ls remote:khld-audiobooks` from CLI works
- Upload via RC API (`operations/copyfile`) works
- Verification via RC API (`operations/list`) fails with bucket restriction error
- File shows up in B2 successfully despite verification failing

## Investigation

1. **Path format difference** - Already tried fixing the path format to include bucket in `fs` parameter
2. **rclone daemon config** - May need proper password decryption
3. **Application key restrictions** - The key is restricted to specific buckets

## Next Steps

1. Restart rclone daemon with `RCLONE_CONFIG_PASS` environment variable set
2. Test if verification works after daemon restart
3. If still failing, investigate why CLI works but RC API doesn't
4. Consider using an unrestricted application key for testing
5. Look into B2 API vs rclone RC API differences

## References

- PRD: "rclone RC API Endpoints Used" section
- rclone docs: https://rclone.org/b2/
