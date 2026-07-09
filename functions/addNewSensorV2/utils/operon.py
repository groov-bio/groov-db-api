# Direct Python port of functions/addNewSensorV2/utils/operon.js — which is
# itself a deliberate port of functions/getOperon/getOperon.py. This module
# matches operon.js's behavior (including its documented divergences from the
# original getOperon.py), NOT the original Python lambda. See PORTING_NOTES at
# the bottom of operon.js (and repeated below) for the deliberate edge-case
# decisions this file must preserve.

import json
import logging
import re

import requests

logger = logging.getLogger()
logger.setLevel(logging.INFO)

NCBI_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/80.0.3987.163 Safari/537.36"
)

CDS_TAG_RE = re.compile(r"<CDS\b([^>]*?)/?>")
ATTR_RE = re.compile(r'(\w+)\s*=\s*"([^"]*)"')


def fetch_text(url, timeout_ms=15000):
    return requests.get(url, headers={"User-Agent": NCBI_USER_AGENT}, timeout=timeout_ms / 1000)


# Parse the attributes of the first <CDS ...> element in an IPG XML doc.
# Mirrors the original Python's iterparse loop that returns the first CDS's
# attrib dict (and operon.js's regex-based re-implementation of the same).
def firstCdsAttributes(xml):
    tag_match = CDS_TAG_RE.search(xml)
    if not tag_match:
        return None
    attr_blob = tag_match.group(1)
    attrs = {}
    for m in ATTR_RE.finditer(attr_blob):
        attrs[m.group(1)] = m.group(2)
    return attrs


def acc2MetaData(access_id):
    logger.info(f"Fetching metadata for access_id: {access_id}")
    url = f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=protein&id={access_id}&rettype=ipg"

    try:
        res = fetch_text(url)
    except requests.RequestException as e:
        logger.error(f"eFetch request failed: {e}")
        return None

    if not res.ok:
        logger.error(f"Non-200 HTTP response: {res.status_code}. eFetch failed")
        return None

    xml = res.text
    try:
        cds = firstCdsAttributes(xml)
        if not cds:
            logger.warning("No CDS element found in XML response")
            return None
        out = {
            "accver": cds.get("accver"),
            "start": cds.get("start"),
            "stop": cds.get("stop"),
            "strand": cds.get("strand"),
        }
        logger.info(f"Metadata retrieved successfully: {json.dumps(out)}")
        return out
    except Exception as err:
        logger.error(f"Exception during metadata retrieval: {err}")
        return None


# Returns a list of "lines" matching the original Python's f.readlines() —
# newline preserved at end of each line, last line may have no trailing
# newline. Equivalent to JS's `text.split(/(?<=\n)/)`: Python's re.split on the
# same zero-width lookbehind leaves one extra trailing '' element whenever the
# text ends with '\n' (JS does not) — strip it to match JS exactly.
def splitLinesKeepNewlines(text):
    if not text:
        return []
    lines = re.split(r"(?<=\n)", text)
    if lines and lines[-1] == "":
        lines.pop()
    return lines


# Per-invocation cache. In the JS port this stores the in-flight Promise so
# concurrent callers for the same NCacc share one fetch+parse instead of
# racing two ~24s downloads; Python's synchronous handler processes proteins
# sequentially, so this simply avoids re-fetching the same NC accession twice
# within (or across) a warm container's lifetime. Only successful completions
# (including a non-OK HTTP response, which legitimately resolves to []) are
# cached — a true network/exception failure is not cached so a later call can
# retry, matching the JS behavior of dropping a rejected promise from the map.
_genome_cache = {}


def NC2genome(NCacc):
    if NCacc in _genome_cache:
        logger.info(f"Genome cache hit for NC accession: {NCacc}")
        return _genome_cache[NCacc]

    logger.info(f"Fetching genome for NC accession: {NCacc}")
    url = f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=nuccore&id={NCacc}&rettype=fasta_cds_aa"
    try:
        res = fetch_text(url, timeout_ms=30000)
    except requests.RequestException as e:
        logger.error(f"Bad request when fetching genome: {e}")
        return []

    text = ""
    if res.ok:
        text = res.text
        logger.info("Genome data retrieved successfully")
    else:
        logger.error(f"Bad request when fetching genome: {res.status_code}")

    genome = splitLinesKeepNewlines(text)
    logger.info(f"Genome parsed with {len(genome)} lines")
    _genome_cache[NCacc] = genome
    return genome


def parseGenome(genome, start, stop):
    logger.info(f"Parsing genome with start {start}, stop {stop}")
    re1 = re.compile(str(start))
    re2 = re.compile(str(stop))
    gene_index = 0
    all_genes = []
    reg_index = None  # stays None if no line matched start/stop
    for line in genome:
        if len(line) > 0 and line[0] == ">":
            if re1.search(line) and re2.search(line):
                reg_index = gene_index
            gene_index += 1
            all_genes.append(line)

    if reg_index is None:
        # The original Python would later raise UnboundLocalError when
        # returning regIndex. Surface that here as an explicit error so the
        # caller gets a clear signal (acc2operon maps this to `return None`).
        raise Exception("parseGenome: no gene matched start/stop pattern")

    logger.info(f"Genome parsed: found {len(all_genes)} genes, regulator at index {reg_index}")
    return {"allGenes": all_genes, "regIndex": reg_index}


def fasta2MetaData(fasta):
    meta_data = {}
    regulator = fasta.split(" [")

    for i in regulator:
        if i[:10] == "locus_tag=":
            meta_data["alias"] = i[10:-1]
        elif i[:8] == "protein=":
            meta_data["description"] = i[8:-1].replace("'", "")
        elif i[:11] == "protein_id=":
            meta_data["link"] = i[11:-1]
        elif i[:9] == "location=":
            if i[9:20] == "complement(":
                meta_data["direction"] = "-"
                location = i[20:-2]
                parts = location.split("..")
                meta_data["start"] = int(re.sub(r"\D", "", parts[0]))
                meta_data["stop"] = int(re.sub(r"\D", "", parts[1]))
            else:
                meta_data["direction"] = "+"
                location = i[9:-1]
                parts = location.split("..")
                meta_data["start"] = int(re.sub(r"\D", "", parts[0]))
                meta_data["stop"] = int(re.sub(r"\D", "", parts[1]))

    if "link" not in meta_data:
        meta_data["link"] = ""

    return meta_data


# Faithful port of operon.js's getOperonWalk (itself a port of the original
# Python getOperon). The original Python relies on Python's negative-index
# list-wrap and a bare try/except to bound the walk; both this port and the JS
# port replicate the *intent* (stop walking when we run off either end or hit
# the 8kb cutoff) via explicit bounds-checking in safe_fasta, without the
# negative-wrap quirk. See PORTING_NOTES below.
def getOperonWalk(all_genes, index, seq_start, strand):
    logger.info(f"Getting operon for gene at index {index} with start {seq_start} and strand {strand}")

    def safe_fasta(idx):
        if idx < 0 or idx >= len(all_genes):
            return None
        try:
            return fasta2MetaData(all_genes[idx])
        except Exception:
            return None

    def get_gene(gene_strand_init, direction, next_gene_init, gene_list, index_init):
        gene_strand = gene_strand_init
        next_gene = next_gene_init
        idx = index_init
        while gene_strand == next_gene.get("direction"):
            next_index = idx + 1 if direction == "+" else idx - 1
            candidate = safe_fasta(next_index)
            if not candidate:
                break
            if abs(seq_start - candidate.get("start")) > 8000:
                break

            if gene_strand == "-" and candidate.get("direction") == "+" and direction == "+":
                gene_list.append(candidate)
            elif gene_strand == "+" and candidate.get("direction") == "-" and direction == "-":
                gene_list.append(candidate)
            elif gene_strand == candidate.get("direction"):
                gene_list.append(candidate)

            next_gene = candidate
            idx = next_index

    gene_strand = strand
    gene_array = []

    # Downstream walk (index - 1 is "down")
    index_down = index - 1
    if index_down >= 0:
        down_gene = safe_fasta(index_down)
        if down_gene:
            if strand == "+" and down_gene.get("direction") == "-":
                gene_strand = down_gene.get("direction")
            downgenes = [down_gene]
            get_gene(gene_strand, "-", down_gene, downgenes, index_down)
            gene_array = list(reversed(downgenes))

    current_gene = safe_fasta(index)
    if current_gene:
        gene_array.append(current_gene)
    regulator_index = len(gene_array) - 1

    gene_strand = strand

    # Upstream walk (index + 1 is "up")
    index_up = index + 1
    up_gene = safe_fasta(index_up)
    if up_gene:
        if strand == "-" and up_gene.get("direction") == "+":
            gene_strand = up_gene.get("direction")
        gene_array.append(up_gene)
        get_gene(gene_strand, "+", up_gene, gene_array, index_up)

    logger.info(f"Operon complete: {len(gene_array)} genes, regulator index: {regulator_index}")
    return {"operon": gene_array, "regulatorIndex": regulator_index}


def acc2operon(accession):
    logger.info(f"Starting acc2operon for accession: {accession}")

    meta_data = acc2MetaData(accession)
    if not meta_data:
        logger.error("Failed to get metadata")
        return None

    genome = NC2genome(meta_data.get("accver"))
    if not genome:
        return None

    try:
        parsed = parseGenome(genome, meta_data.get("start"), meta_data.get("stop"))
    except Exception as err:
        logger.error(f"parseGenome failed: {err}")
        return None

    all_genes = parsed["allGenes"]
    reg_index = parsed["regIndex"]

    reg = fasta2MetaData(all_genes[reg_index])
    walk = getOperonWalk(all_genes, reg_index, reg.get("start"), reg.get("direction"))

    return {"operon": walk["operon"], "regIndex": walk["regulatorIndex"], "genome": meta_data.get("accver")}


# PORTING_NOTES
#
# 1. Negative-index wrap (get_gene): the original Python's list[-1] silently
#    returns the last element. Inside the recursive walker the original code
#    does `index - 1` without bounds checking, so a deep downstream walk could
#    wrap to the end of the genome — almost always rejected by the 8kb
#    distance cutoff, but technically a latent bug. Both the JS port and this
#    port bound explicitly via safe_fasta(); the 8kb cutoff was already doing
#    this work in practice.
#
# 2. parseGenome unbound reg_index: the original Python raises
#    UnboundLocalError if no line matched. This port (matching operon.js)
#    raises an explicit Exception with a clear message, and acc2operon returns
#    None, mapping cleanly to the original "Failed to process accession" path.
#
# 3. /tmp/genome.txt round-trip: the original Python writes then reads the
#    genome from /tmp. On a warm Lambda container this can return STALE data
#    from a previous invocation if the eFetch call failed. Neither the JS port
#    nor this port replicates that — a failed fetch returns []. This is a
#    deliberate divergence that fixes a real bug.
#
# 4. First-CDS-wins: NCBI IPG XML can contain many <CDS> elements; the
#    original Python returns the first one and bails. The regex in
#    firstCdsAttributes matches the first <CDS ...> only.
#
# 5. re.compile(start) on a plain digit string is equivalent to JS's
#    `new RegExp(start)` for all values NCBI ever returns for these
#    coordinate fields.
