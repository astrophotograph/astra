//! Integration test for the processinator-backed stretch shim: a synthetic
//! FITS frame goes through `stretch::generate_preview` and comes out as a
//! decodable JPEG of the same dimensions.

use astra_lib::stretch::{generate_preview, StretchParams};
use processinator::synthetic::{make_test_image, SyntheticParams};
use processinator::write_fits;

#[test]
fn generate_preview_via_processinator() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let fits_path = tmp.path().join("frame.fits");
    let out_path = tmp.path().join("frame.jpg");

    // Realistic frame: color cast, gradient, nebulosity, stacking edges
    let img = make_test_image(&SyntheticParams {
        rgb: true,
        gradient_amplitude: 300.0,
        nebula_amplitude: 150.0,
        dark_edges: (10, 0, 14, 0),
        seed: 13,
        ..Default::default()
    });
    write_fits(&img.data, &fits_path).expect("write FITS");

    let result = generate_preview(&fits_path, &out_path, &StretchParams::default())
        .expect("generate preview");
    assert_eq!(result, out_path.to_string_lossy());

    let decoded = image::open(&out_path).expect("decode JPEG");
    assert_eq!(decoded.width(), img.data.width() as u32);
    assert_eq!(decoded.height(), img.data.height() as u32);
}
