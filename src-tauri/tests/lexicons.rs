//! The `gallery.astra.*` lexicons under `../lexicons` load in kenning and
//! accept records built from a `ShareManifest`-shaped sample
//! (`viewer/src/types.ts`), including the float-to-integer encodings the
//! lexicons require; targeted mutations are rejected at the expected paths.
//!
//! The sample manifest is written by hand here because the repo carries no
//! `manifest.json` fixture; its shape follows `viewer/src/types.ts` and the
//! unit tests in `src/share/manifest.rs`. The conversion helpers in this
//! file are the reference for the publish path: the same scalings are
//! documented per field in `lexicons/README.md`.

use std::sync::OnceLock;

use kenning::lexicon::{LexDef, LexiconRegistry, ValidationError};
use kenning::record::{AtUri, Nsid, Record, Rkey};
use serde_json::{json, Value};

const LEXICONS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../lexicons");

const COLLECTION: &str = "gallery.astra.collection";
const IMAGE: &str = "gallery.astra.image";
const EQUIPMENT: &str = "gallery.astra.equipment";
const PROFILE: &str = "gallery.astra.profile";

const DID: &str = "did:plc:z72i7hdynmk6r22z27h6tvur";
/// A dag-cbor CID, as a record reference would carry.
const RECORD_CID: &str = "bafyreibaaieigry2etw7p6k74hvdz53i5x6myssdqhlcaoyd3edalgiuzm";
/// A raw-codec CID, as a blob reference would carry.
const BLOB_CID: &str = "bafkreienhu3nspbm2f2v5q74arjtlvltdlgruzjvo6ndlggksp6l6zlf5a";
/// TIDs assigned to the two sample images at publish time.
const IMAGE_TIDS: [&str; 2] = ["3myx7vphq3s2j", "3myx7vphq3s2k"];
/// The collection's publish slug doubles as its record key (`key: any`).
const COLLECTION_SLUG: &str = "orion-session";

fn registry() -> &'static LexiconRegistry {
    static REG: OnceLock<LexiconRegistry> = OnceLock::new();
    REG.get_or_init(|| LexiconRegistry::from_dir(LEXICONS).expect("gallery.astra lexicons load"))
}

fn nsid(s: &str) -> Nsid {
    Nsid::new(s).unwrap()
}

fn at_uri(collection: &str, rkey: &str) -> AtUri {
    AtUri::new(DID, nsid(collection), Rkey::new(rkey).unwrap()).unwrap()
}

#[track_caller]
fn assert_error_at(errors: &[ValidationError], path: &str, needle: &str) {
    let hit = errors
        .iter()
        .find(|e| e.path == path)
        .unwrap_or_else(|| panic!("no error at `{path}`; got {errors:#?}"));
    assert!(
        hit.message.contains(needle),
        "error at `{path}` should mention {needle:?}: {}",
        hit.message
    );
}

#[track_caller]
fn assert_only_error_at(errors: &[ValidationError], path: &str, needle: &str) {
    assert_error_at(errors, path, needle);
    assert_eq!(
        errors.len(),
        1,
        "expected exactly one error, got {errors:#?}"
    );
}

// ---------------------------------------------------------------------------
// Sample manifest (ShareManifest shape from viewer/src/types.ts)
// ---------------------------------------------------------------------------

fn sample_manifest() -> Value {
    json!({
        "version": 1,
        "collectionName": "Orion Session",
        "collectionDescription": "Winter imaging from the back garden",
        "template": null,
        "imageCount": 2,
        "updatedAt": "2026-01-20T03:12:45.117Z",
        // collections.metadata.dateFilter carries bare dates.
        "dateRangeStart": "2026-01-01",
        "dateRangeEnd": "2026-01-31",
        "images": [
            {
                "id": "img-1",
                "filename": "m42.jpg",
                "summary": "M42 and the Running Man, 40 x 30 s",
                "contentType": "image/jpeg",
                "imagePath": "images/img-1.jpg",
                "thumbPath": "thumbs/img-1.jpg",
                // images.created_at is a NaiveDateTime, which Display-formats
                // with a space and no zone; the publish path must normalise it.
                "createdAt": "2026-01-15 20:00:00",
                "favorite": true,
                "catalogIds": ["M42", "NGC1976", "NGC1977"],
                "plateSolve": {
                    "centerRa": 83.822,
                    "centerDec": -5.391,
                    "pixelScale": 1.5,
                    "rotation": 0.5,
                    "widthDeg": 1.2,
                    "heightDeg": 0.8,
                    "imageWidth": 4096,
                    "imageHeight": 2160
                },
                "objects": [
                    {
                        "name": "M 42",
                        "ra": 83.822,
                        "dec": -5.391,
                        "magnitude": 4.0,
                        "sizeArcmin": 85.0,
                        "pixelX": 2048.4,
                        "pixelY": 1079.6,
                        "radiusPx": 500.0
                    },
                    {
                        "name": "NGC 1977",
                        "ra": 83.8458,
                        "dec": -4.8125,
                        "magnitude": null,
                        "sizeArcmin": 20.0,
                        "pixelX": 2030.0,
                        "pixelY": -12.0,
                        "radiusPx": 118.2
                    }
                ]
            },
            {
                "id": "img-2",
                "filename": "ngc7000_stack.fits",
                "summary": null,
                "contentType": "image/fits",
                "imagePath": "images/img-2.fits",
                "thumbPath": "thumbs/img-2.jpg",
                "createdAt": "2026-01-16T21:30:00Z",
                "favorite": false,
                "catalogIds": [],
                "plateSolve": null,
                "objects": []
            }
        ]
    })
}

// ---------------------------------------------------------------------------
// Manifest -> record conversion (the encodings lexicons/README.md documents)
// ---------------------------------------------------------------------------

/// Degrees to millionths of a degree.
fn micro_deg(deg: f64) -> i64 {
    (deg * 1e6).round() as i64
}

/// A quantity to thousandths of itself (degrees -> milli-degrees,
/// arcsec -> milli-arcsec, magnitudes -> milli-magnitudes).
fn milli(x: f64) -> i64 {
    (x * 1e3).round() as i64
}

/// Arcminutes to tenths of an arcsecond.
fn arcsec_tenths(arcmin: f64) -> i64 {
    (arcmin * 600.0).round() as i64
}

/// Pixel coordinate to the nearest whole pixel.
fn px(v: f64) -> i64 {
    v.round() as i64
}

/// Manifest/DB timestamps into the lexicon `datetime` format. The manifest
/// carries three shapes: RFC 3339 (`updatedAt`), `NaiveDateTime` Display
/// (`YYYY-MM-DD HH:MM:SS`, from `images.created_at`) and bare dates
/// (`dateFilter`). Naive values are treated as UTC.
fn datetime(s: &str) -> String {
    if s.len() == 10 {
        return format!("{s}T00:00:00Z");
    }
    if s.len() >= 19 && s.as_bytes()[10] == b' ' {
        let mut out = s.replacen(' ', "T", 1);
        if !out.ends_with('Z') && !out.contains('+') {
            out.push('Z');
        }
        return out;
    }
    s.to_string()
}

fn blob(mime: &str, size: u64) -> Value {
    json!({ "$type": "blob", "ref": { "$link": BLOB_CID }, "mimeType": mime, "size": size })
}

fn opt_int(v: &Value, f: impl Fn(f64) -> i64) -> Value {
    match v.as_f64() {
        Some(x) => json!(f(x)),
        None => Value::Null,
    }
}

/// Insert `key` only when the converted value is not null (optional
/// properties are omitted rather than set to `null`: none are `nullable`).
fn put_opt(obj: &mut serde_json::Map<String, Value>, key: &str, v: Value) {
    if !v.is_null() {
        obj.insert(key.to_string(), v);
    }
}

fn plate_solve_record(ps: &Value) -> Value {
    let mut out = json!({
        "centerRaMicroDeg": micro_deg(ps["centerRa"].as_f64().unwrap()),
        "centerDecMicroDeg": micro_deg(ps["centerDec"].as_f64().unwrap()),
        "pixelScaleMilliArcsec": milli(ps["pixelScale"].as_f64().unwrap()),
        "rotationMilliDeg": milli(ps["rotation"].as_f64().unwrap()),
        "widthMilliDeg": milli(ps["widthDeg"].as_f64().unwrap()),
        "heightMilliDeg": milli(ps["heightDeg"].as_f64().unwrap()),
    });
    let map = out.as_object_mut().unwrap();
    put_opt(map, "imageWidth", ps["imageWidth"].clone());
    put_opt(map, "imageHeight", ps["imageHeight"].clone());
    out
}

fn catalog_object_record(obj: &Value) -> Value {
    let mut out = json!({
        "name": obj["name"],
        "raMicroDeg": micro_deg(obj["ra"].as_f64().unwrap()),
        "decMicroDeg": micro_deg(obj["dec"].as_f64().unwrap()),
    });
    let map = out.as_object_mut().unwrap();
    put_opt(map, "magnitudeMilli", opt_int(&obj["magnitude"], milli));
    put_opt(
        map,
        "sizeArcsecTenths",
        opt_int(&obj["sizeArcmin"], arcsec_tenths),
    );
    put_opt(map, "pixelX", opt_int(&obj["pixelX"], px));
    put_opt(map, "pixelY", opt_int(&obj["pixelY"], px));
    put_opt(map, "radiusPx", opt_int(&obj["radiusPx"], px));
    out
}

/// One `gallery.astra.image` body from a `ManifestImage`. `imagePath` and
/// `thumbPath` become the `preview` and `thumbnail` blobs (the sample uses a
/// fixed CID and size); the original is attached with the manifest's
/// `contentType`.
fn image_record(img: &Value) -> Value {
    let content_type = img["contentType"].as_str().unwrap();
    let mut out = json!({
        "$type": IMAGE,
        "filename": img["filename"],
        "contentType": content_type,
        "createdAt": datetime(img["createdAt"].as_str().unwrap()),
        "favorite": img["favorite"],
        "catalogIds": img["catalogIds"],
        "preview": blob("image/jpeg", 338_807),
        "thumbnail": blob("image/jpeg", 24_120),
        "original": blob(content_type, 8_421_120),
        "objects": img["objects"]
            .as_array()
            .unwrap()
            .iter()
            .map(catalog_object_record)
            .collect::<Vec<_>>(),
    });
    let map = out.as_object_mut().unwrap();
    put_opt(map, "summary", img["summary"].clone());
    if let Some(ps) = img.get("plateSolve").filter(|v| !v.is_null()) {
        map.insert("plateSolve".into(), plate_solve_record(ps));
    }
    out
}

fn image_ref(tid: &str) -> Value {
    json!({ "uri": format!("at://{DID}/{IMAGE}/{tid}"), "cid": RECORD_CID })
}

/// The `gallery.astra.collection` body from a `ShareManifest` plus the
/// image records' URIs/CIDs and the `published_collections` row's
/// visibility.
fn collection_record(manifest: &Value, visibility: &str) -> Value {
    let images: Vec<Value> = IMAGE_TIDS.iter().map(|tid| image_ref(tid)).collect();
    let mut out = json!({
        "$type": COLLECTION,
        "title": manifest["collectionName"],
        "createdAt": "2026-01-10T18:00:00Z",
        "updatedAt": datetime(manifest["updatedAt"].as_str().unwrap()),
        "images": images,
        "visibility": visibility,
        "coverImage": image_ref(IMAGE_TIDS[0]),
    });
    let map = out.as_object_mut().unwrap();
    put_opt(
        map,
        "description",
        manifest["collectionDescription"].clone(),
    );
    put_opt(map, "template", manifest["template"].clone());
    for (from, to) in [
        ("dateRangeStart", "dateRangeStart"),
        ("dateRangeEnd", "dateRangeEnd"),
    ] {
        if let Some(d) = manifest[from].as_str() {
            map.insert(to.into(), json!(datetime(d)));
        }
    }
    out
}

fn sample_images() -> Vec<Value> {
    sample_manifest()["images"]
        .as_array()
        .unwrap()
        .iter()
        .map(image_record)
        .collect()
}

fn sample_collection() -> Value {
    collection_record(&sample_manifest(), "public")
}

fn equipment_record() -> Value {
    json!({
        "$type": EQUIPMENT,
        "kind": "preset",
        "name": "Seestar S50",
        "make": "ZWO",
        "model": "S50",
        "specs": {
            "apertureMm": 50,
            "focalLengthMm": 250,
            "pixelSizeMicrons": 2900,
            "resolution": "1080 x 1920",
            "opticalType": "Apochromatic refractor"
        },
        "createdAt": "2025-11-02T09:15:00Z"
    })
}

fn profile_record() -> Value {
    json!({
        "$type": PROFILE,
        "displayName": "Alice Hubble",
        "bio": "Backyard imager, mostly nebulae.",
        "avatar": blob("image/png", 102_400),
        "createdAt": "2025-10-01T12:00:00Z"
    })
}

fn errors(nsid_str: &str, body: &Value) -> Vec<ValidationError> {
    registry()
        .validate(&nsid(nsid_str), body)
        .err()
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

#[test]
fn registry_loads_the_four_gallery_astra_lexicons() {
    let reg = registry();
    assert_eq!(reg.len(), 4);
    for (id, key) in [
        (COLLECTION, "any"),
        (IMAGE, "tid"),
        (EQUIPMENT, "tid"),
        (PROFILE, "literal:self"),
    ] {
        let doc = reg.get(&nsid(id)).unwrap_or_else(|| panic!("{id} loaded"));
        assert_eq!(doc.lexicon, 1);
        assert!(doc.description.is_some(), "{id} has a description");
        match doc.main() {
            Some(LexDef::Record(rec)) => assert_eq!(rec.key.as_deref(), Some(key), "{id} key"),
            other => panic!("{id} main should be a record, got {other:?}"),
        }
    }
    // Cross-file and local object refs resolve.
    for r in [
        "gallery.astra.collection#imageRef",
        "gallery.astra.image#plateSolve",
        "gallery.astra.image#catalogObject",
        "gallery.astra.equipment#equipmentRef",
    ] {
        assert!(
            matches!(reg.resolve_ref(r, &nsid(IMAGE)), Ok(LexDef::Object(_))),
            "{r} resolves to an object"
        );
    }
}

// ---------------------------------------------------------------------------
// Sample records validate
// ---------------------------------------------------------------------------

#[test]
fn sample_collection_and_images_validate_with_no_errors_or_warnings() {
    let reg = registry();

    let collection = sample_collection();
    let report = reg.check(COLLECTION, &collection);
    assert!(report.errors.is_empty(), "{:#?}", report.errors);
    assert!(report.warnings.is_empty(), "{:#?}", report.warnings);
    let record = Record::new(at_uri(COLLECTION, COLLECTION_SLUG), collection).unwrap();
    assert_eq!(reg.validate_record(&record), Ok(()));

    let images = sample_images();
    assert_eq!(images.len(), 2);
    for (img, tid) in images.iter().zip(IMAGE_TIDS) {
        let report = reg.check(IMAGE, img);
        assert!(report.errors.is_empty(), "{:#?}", report.errors);
        assert!(report.warnings.is_empty(), "{:#?}", report.warnings);
        let record = Record::new(at_uri(IMAGE, tid), img.clone()).unwrap();
        assert_eq!(reg.validate_record(&record), Ok(()));
    }
}

#[test]
fn conversion_encodes_floats_as_documented_integers() {
    let images = sample_images();
    let ps = &images[0]["plateSolve"];
    assert_eq!(ps["centerRaMicroDeg"], json!(83_822_000));
    assert_eq!(ps["centerDecMicroDeg"], json!(-5_391_000));
    assert_eq!(ps["pixelScaleMilliArcsec"], json!(1_500));
    assert_eq!(ps["rotationMilliDeg"], json!(500));
    assert_eq!(ps["widthMilliDeg"], json!(1_200));
    assert_eq!(ps["heightMilliDeg"], json!(800));
    assert_eq!(ps["imageWidth"], json!(4096));
    assert_eq!(ps["imageHeight"], json!(2160));

    let m42 = &images[0]["objects"][0];
    assert_eq!(m42["raMicroDeg"], json!(83_822_000));
    assert_eq!(m42["magnitudeMilli"], json!(4_000));
    assert_eq!(m42["sizeArcsecTenths"], json!(51_000));
    assert_eq!(m42["pixelX"], json!(2048));
    assert_eq!(m42["pixelY"], json!(1080));
    assert_eq!(m42["radiusPx"], json!(500));

    // Null optionals are omitted, not emitted as null; off-frame pixel
    // positions may be negative.
    let ngc1977 = &images[0]["objects"][1];
    assert!(ngc1977.get("magnitudeMilli").is_none());
    assert_eq!(ngc1977["pixelY"], json!(-12));
    assert_eq!(ngc1977["radiusPx"], json!(118));

    // Timestamps are normalised to the lexicon datetime format.
    assert_eq!(images[0]["createdAt"], json!("2026-01-15T20:00:00Z"));
    assert_eq!(images[1]["createdAt"], json!("2026-01-16T21:30:00Z"));
    let collection = sample_collection();
    assert_eq!(collection["dateRangeStart"], json!("2026-01-01T00:00:00Z"));
    assert_eq!(collection["updatedAt"], json!("2026-01-20T03:12:45.117Z"));

    // An unsolved FITS image carries no plateSolve and an empty objects list.
    assert!(images[1].get("plateSolve").is_none());
    assert!(images[1].get("summary").is_none());
    assert_eq!(images[1]["objects"], json!([]));
    assert_eq!(images[1]["original"]["mimeType"], json!("image/fits"));
}

#[test]
fn circle_visibility_is_accepted_because_known_values_are_open() {
    let body = collection_record(&sample_manifest(), "circle:close-friends");
    assert!(errors(COLLECTION, &body).is_empty());
    let body = collection_record(&sample_manifest(), "unlisted");
    assert!(errors(COLLECTION, &body).is_empty());
}

// ---------------------------------------------------------------------------
// Mutations are rejected at the expected paths
// ---------------------------------------------------------------------------

#[test]
fn collection_without_title_fails_at_title() {
    let mut body = sample_collection();
    body.as_object_mut().unwrap().remove("title");
    assert_only_error_at(&errors(COLLECTION, &body), "title", "missing required");
}

#[test]
fn float_center_ra_fails_at_plate_solve_center_ra() {
    let mut body = sample_images().remove(0);
    body["plateSolve"]["centerRaMicroDeg"] = json!(83.822);
    assert_only_error_at(
        &errors(IMAGE, &body),
        "plateSolve.centerRaMicroDeg",
        "float",
    );
    // Even a float with no fractional part is not an integer in DAG-CBOR.
    body["plateSolve"]["centerRaMicroDeg"] = json!(83822000.0);
    assert_only_error_at(
        &errors(IMAGE, &body),
        "plateSolve.centerRaMicroDeg",
        "float",
    );
}

#[test]
fn bad_datetime_fails_at_created_at() {
    let mut body = sample_images().remove(0);
    // The raw NaiveDateTime Display form must not reach the record.
    body["createdAt"] = json!("2026-01-15 20:00:00");
    assert_only_error_at(&errors(IMAGE, &body), "createdAt", "datetime");
    body["createdAt"] = json!("2026-01-15");
    assert_only_error_at(&errors(IMAGE, &body), "createdAt", "datetime");
}

#[test]
fn video_preview_fails_at_preview_mime_type() {
    let mut body = sample_images().remove(0);
    body["preview"] = blob("video/mp4", 4096);
    assert_only_error_at(&errors(IMAGE, &body), "preview.mimeType", "not accepted");
    // `original` has no accept list, so any type is fine there.
    body["preview"] = blob("image/webp", 4096);
    body["original"] = blob("video/mp4", 4096);
    assert!(errors(IMAGE, &body).is_empty());
}

#[test]
fn bad_image_uri_fails_at_images_0_uri() {
    let mut body = sample_collection();
    body["images"][0]["uri"] = json!("https://astra.gallery/alice/orion-session");
    assert_only_error_at(&errors(COLLECTION, &body), "images[0].uri", "at-uri");
}

#[test]
fn image_record_with_non_tid_key_fails_at_rkey() {
    let reg = registry();
    let record = Record::new(at_uri(IMAGE, "img-1"), sample_images().remove(0)).unwrap();
    let errors = reg.validate_record(&record).unwrap_err();
    assert_only_error_at(&errors, "rkey", "TID");
}

// ---------------------------------------------------------------------------
// Equipment and profile
// ---------------------------------------------------------------------------

#[test]
fn equipment_record_validates() {
    let reg = registry();
    let body = equipment_record();
    assert!(
        errors(EQUIPMENT, &body).is_empty(),
        "{:#?}",
        errors(EQUIPMENT, &body)
    );
    let record = Record::new(at_uri(EQUIPMENT, "3myx7vphq3s2l"), body.clone()).unwrap();
    assert_eq!(reg.validate_record(&record), Ok(()));

    // Unknown kinds are allowed (knownValues is advisory)...
    let mut open = body.clone();
    open["kind"] = json!("guide-scope");
    assert!(errors(EQUIPMENT, &open).is_empty());
    // ...but the required fields are not optional.
    let mut missing = body;
    missing.as_object_mut().unwrap().remove("name");
    assert_only_error_at(&errors(EQUIPMENT, &missing), "name", "missing required");
}

#[test]
fn image_may_reference_equipment() {
    let mut body = sample_images().remove(0);
    body["equipment"] = json!([
        { "uri": format!("at://{DID}/{EQUIPMENT}/3myx7vphq3s2l"), "cid": RECORD_CID }
    ]);
    assert!(
        errors(IMAGE, &body).is_empty(),
        "{:#?}",
        errors(IMAGE, &body)
    );
    body["equipment"][0]["cid"] = json!("not-a-cid");
    assert_only_error_at(&errors(IMAGE, &body), "equipment[0].cid", "cid");
}

#[test]
fn profile_validates_at_self_and_rejects_other_keys() {
    let reg = registry();
    let body = profile_record();
    let record = Record::new(at_uri(PROFILE, "self"), body.clone()).unwrap();
    assert_eq!(reg.validate_record(&record), Ok(()));

    // Every property is optional: an empty profile is still a profile.
    let empty = json!({ "$type": PROFILE });
    assert!(errors(PROFILE, &empty).is_empty());

    let record = Record::new(at_uri(PROFILE, "3myx7vphq3s2j"), body).unwrap();
    let errors = reg.validate_record(&record).unwrap_err();
    assert_only_error_at(&errors, "rkey", "literal `self`");
}
