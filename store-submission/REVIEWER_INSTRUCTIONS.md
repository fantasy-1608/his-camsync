# Reviewer test instructions — HIS CamSync 1.6.2

This extension integrates only with authorized VNPT HIS pages under *.vncare.vn/vnpthis/. Full functionality requires access to a compatible HIS installation and a phone browser. The phone application is hosted at https://fantasy-1608.github.io/his-camsync/ and is opened through the pairing QR.

Before submitting, the publisher must supply an approved demo URL/account containing synthetic records, or describe the available alternative review arrangement. No production hospital credentials or patient records should be supplied. This file currently contains no demo credentials.

1. Install the submitted extension package and sign in to the approved demo HIS.
2. Open a synthetic imaging order, then the CDHA result dialog and Hình ảnh tab.
3. Click Quét từ ĐT. Scan the pairing QR with a phone. Do not share QR screenshots: they contain session access material.
4. Select a synthetic JPG/PNG, preview it, and send. Desktop should receive the file and initiate the native Upload when the bound patient and sample/result/service identifiers are unchanged. Verify the image in HIS separately; FILE_READY is delivery to the attachment input, not proof of server persistence.
5. Repeat with an approved synthetic PDF scan form. The selection handler prepares the PDF; choose the appropriate form name and click Save manually. No automatic signing occurs.
6. Close the target dialog or expire the pairing session before sending: transfer must be rejected. Change patient or sample/result/service within the target: automatic upload must stop.
7. Send again only after checking the prior result. A duplicate transfer ID must not repeat upload. An occupied single-file input must be preserved.

WebRTC is preferred where available. Cloud mode uses encrypted payloads over Supabase private relay. The extension does not load remote executable JavaScript. Session timeout is five minutes; open a fresh QR when expired.
