//! `decode` and `encode` for the browser, exported as plain WebAssembly
//! functions. There is no wasm-bindgen here: the interface is small enough to
//! pass by hand, which keeps the module free of generated glue.
//!
//! WebAssembly functions can only take and return numbers, so strings and byte
//! buffers cross the boundary as an address and a length in this module's
//! linear memory:
//!
//! 1. JS calls `alloc` and copies its input into the returned address.
//! 2. JS calls `decode` or `encode`. Each takes ownership of nothing: the input
//!    stays allocated, and JS frees it with `dealloc` afterwards.
//! 3. The result comes back as one `u64`, address in the high half and length
//!    in the low half. JS copies it out and frees it with `dealloc`.
use chardetng::{EncodingDetector, Iso2022JpDetection, Utf8Detection};
use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};
use std::mem;

const STATUS_OK: u8 = 0;
const STATUS_UNKNOWN_LABEL: u8 = 1;

/// Reserve `len` bytes and return their address. `Vec::with_capacity` owns the
/// memory; `mem::forget` stops Rust freeing it when `buf` goes out of scope, so
/// it stays valid until `dealloc` rebuilds the Vec and lets it drop.
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    mem::forget(buf);
    ptr
}

/// # Safety
/// `ptr` and `len` must come from `alloc`, or from a pair returned by `decode`
/// or `encode`, and must not be freed twice.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len));
}

/// Hand a finished buffer to JS: shrink it so capacity equals length (`dealloc`
/// relies on that), forget it, and pack address and length into one number.
fn hand_over(mut out: Vec<u8>) -> u64 {
    out.shrink_to_fit();
    let (ptr, len) = (out.as_mut_ptr(), out.len());
    mem::forget(out);
    ((ptr as u64) << 32) | len as u64
}

unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(ptr, len)
    }
}

/// Decode `input`. A non-empty label forces that encoding, as the Reopen with
/// Encoding menu does; otherwise a BOM wins, then chardetng guesses.
///
/// Result layout: status, flags (bit 0 lossy, bit 1 BOM), name length, name,
/// then the text as UTF-8.
///
/// # Safety
/// Both address and length pairs must describe live memory from `alloc`.
#[no_mangle]
pub unsafe extern "C" fn decode(
    input: *const u8,
    input_len: usize,
    label: *const u8,
    label_len: usize,
) -> u64 {
    let input = bytes(input, input_len);
    let label = bytes(label, label_len);
    let forced = if label.is_empty() {
        None
    } else {
        match Encoding::for_label(label) {
            Some(enc) => Some(enc),
            None => return hand_over(vec![STATUS_UNKNOWN_LABEL]),
        }
    };
    let bom = Encoding::for_bom(input).map(|(enc, _)| enc);
    let enc = forced.or(bom).unwrap_or_else(|| {
        let mut detector = EncodingDetector::new(Iso2022JpDetection::Allow);
        detector.feed(input, true);
        detector.guess(None, Utf8Detection::Allow)
    });
    let (text, _, lossy) = enc.decode(input);
    let name = enc.name().as_bytes();
    let mut out = Vec::with_capacity(3 + name.len() + text.len());
    out.push(STATUS_OK);
    out.push(u8::from(lossy) | (u8::from(bom.is_some()) << 1));
    out.push(name.len() as u8);
    out.extend_from_slice(name);
    out.extend_from_slice(text.as_bytes());
    hand_over(out)
}

/// Encode UTF-8 `text` as `label`. Result layout: status, then the bytes.
/// encoding_rs refuses to write UTF-16 (the web platform never does), so that
/// case is spelled out, as it is in `encode_contents` on the desktop.
///
/// # Safety
/// Both address and length pairs must describe live memory from `alloc`, and
/// `text` must be valid UTF-8 (TextEncoder guarantees that).
#[no_mangle]
pub unsafe extern "C" fn encode(
    text: *const u8,
    text_len: usize,
    label: *const u8,
    label_len: usize,
    bom: u32,
) -> u64 {
    let text = std::str::from_utf8_unchecked(bytes(text, text_len));
    let Some(enc) = Encoding::for_label(bytes(label, label_len)) else {
        return hand_over(vec![STATUS_UNKNOWN_LABEL]);
    };
    let bom = bom != 0;
    let mut out = Vec::with_capacity(text.len() + 4);
    out.push(STATUS_OK);
    if enc == UTF_16LE || enc == UTF_16BE {
        let little = enc == UTF_16LE;
        if bom {
            out.extend_from_slice(if little { &[0xFF, 0xFE] } else { &[0xFE, 0xFF] });
        }
        for unit in text.encode_utf16() {
            out.extend_from_slice(&if little { unit.to_le_bytes() } else { unit.to_be_bytes() });
        }
    } else if enc == UTF_8 {
        if bom {
            out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
        }
        out.extend_from_slice(text.as_bytes());
    } else {
        let (encoded, _, _) = enc.encode(text);
        out.extend_from_slice(&encoded);
    }
    hand_over(out)
}
