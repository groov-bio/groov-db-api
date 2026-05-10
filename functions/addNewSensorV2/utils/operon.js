// Direct JS port of functions/getOperon/getOperon.py — eliminates the
// cross-Lambda invoke from addNewSensorV2 → getOperon. Behavior is intended
// to match the Python source one-for-one, including its quirks; see
// PORTING_NOTES at the bottom of this file for the deliberate edge-case
// decisions.

import fetch from 'node-fetch';
import { logger } from './logger.js';

const NCBI_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.163 Safari/537.36';

const fetchText = async (url, timeoutMs = 15000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': NCBI_USER_AGENT },
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
};

// Parse the attributes of the first <CDS ...> element in an IPG XML doc.
// Mirrors Python's iterparse loop that returns the first CDS's attrib dict.
const firstCdsAttributes = (xml) => {
  const tagMatch = xml.match(/<CDS\b([^>]*?)\/?>/);
  if (!tagMatch) return null;
  const attrBlob = tagMatch[1];
  const attrs = {};
  const attrRe = /(\w+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = attrRe.exec(attrBlob)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
};

export const acc2MetaData = async (accessId) => {
  logger.info(`Fetching metadata for access_id: ${accessId}`);
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=protein&id=${accessId}&rettype=ipg`;

  const res = await fetchText(url);
  if (!res.ok) {
    logger.error(`Non-200 HTTP response: ${res.status}. eFetch failed`);
    return null;
  }
  const xml = await res.text();
  try {
    const cds = firstCdsAttributes(xml);
    if (!cds) {
      logger.warn('No CDS element found in XML response');
      return null;
    }
    const out = {
      accver: cds.accver,
      start: cds.start,
      stop: cds.stop,
      strand: cds.strand,
    };
    logger.info(`Metadata retrieved successfully: ${JSON.stringify(out)}`);
    return out;
  } catch (err) {
    logger.error(`Exception during metadata retrieval: ${err.message}`);
    return null;
  }
};

// Returns an array of "lines" matching Python's f.readlines() — newline
// preserved at end of each line, last line may have no trailing newline.
const splitLinesKeepNewlines = (text) => {
  if (!text) return [];
  const lines = text.split(/(?<=\n)/);
  return lines;
};

// Per-invocation cache. Stores the in-flight Promise so concurrent callers for
// the same NCacc share one fetch+parse instead of racing two ~24s downloads.
const genomeCache = new Map();

export const NC2genome = async (NCacc) => {
  if (genomeCache.has(NCacc)) {
    logger.info(`Genome cache hit for NC accession: ${NCacc}`);
    return genomeCache.get(NCacc);
  }
  const p = (async () => {
    logger.info(`Fetching genome for NC accession: ${NCacc}`);
    const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=nuccore&id=${NCacc}&rettype=fasta_cds_aa`;
    const res = await fetchText(url, 30000);

    let text = '';
    if (res.ok) {
      text = await res.text();
      logger.info('Genome data retrieved successfully');
    } else {
      logger.error(`Bad request when fetching genome: ${res.status}`);
    }
    const genome = splitLinesKeepNewlines(text);
    logger.info(`Genome parsed with ${genome.length} lines`);
    return genome;
  })();
  genomeCache.set(NCacc, p);
  // On failure, drop the cached rejection so a subsequent caller can retry.
  p.catch(() => genomeCache.delete(NCacc));
  return p;
};

export const parseGenome = (genome, start, stop) => {
  logger.info(`Parsing genome with start ${start}, stop ${stop}`);
  const re1 = new RegExp(start);
  const re2 = new RegExp(stop);
  let geneIndex = 0;
  const allGenes = [];
  let regIndex; // intentionally undefined if no match — matches Python's UnboundLocalError surface
  for (const line of genome) {
    if (line.length > 0 && line[0] === '>') {
      if (re1.test(line) && re2.test(line)) {
        regIndex = geneIndex;
      }
      geneIndex += 1;
      allGenes.push(line);
    }
  }
  if (regIndex === undefined) {
    // Python would later raise UnboundLocalError when returning regIndex.
    // Surface that here as an explicit error so the caller gets a clear signal.
    throw new Error('parseGenome: no gene matched start/stop pattern');
  }
  logger.info(`Genome parsed: found ${allGenes.length} genes, regulator at index ${regIndex}`);
  return { allGenes, regIndex };
};

export const fasta2MetaData = (fasta) => {
  const metaData = {};
  const regulator = fasta.split(' [');

  for (const i of regulator) {
    if (i.startsWith('locus_tag=')) {
      metaData.alias = i.slice(10, -1);
    } else if (i.startsWith('protein=')) {
      metaData.description = i.slice(8, -1).replace(/'/g, '');
    } else if (i.startsWith('protein_id=')) {
      metaData.link = i.slice(11, -1);
    } else if (i.startsWith('location=')) {
      // Check for 'complement(' starting at offset 9
      if (i.slice(9, 20) === 'complement(') {
        metaData.direction = '-';
        let location = i.slice(20, -2);
        const parts = location.split('..');
        metaData.start = parseInt(parts[0].replace(/\D/g, ''), 10);
        metaData.stop = parseInt(parts[1].replace(/\D/g, ''), 10);
      } else {
        metaData.direction = '+';
        let location = i.slice(9, -1);
        const parts = location.split('..');
        metaData.start = parseInt(parts[0].replace(/\D/g, ''), 10);
        metaData.stop = parseInt(parts[1].replace(/\D/g, ''), 10);
      }
    }
  }

  if (!('link' in metaData)) metaData.link = '';

  return metaData;
};

// Faithful port of Python getOperon. The Python version relies on Python's
// negative-index list-wrap and on bare `try/except` to bound the walk. In JS
// we replicate the *intent* (stop walking when we run off either end or hit
// the 8kb cutoff) without the negative-wrap quirk. See PORTING_NOTES.
export const getOperonWalk = (allGenes, index, seqStart, strand) => {
  logger.info(`Getting operon for gene at index ${index} with start ${seqStart} and strand ${strand}`);

  const safeFasta = (idx) => {
    if (idx < 0 || idx >= allGenes.length) return null;
    try {
      return fasta2MetaData(allGenes[idx]);
    } catch {
      return null;
    }
  };

  const getGene = (geneStrandInit, direction, nextGeneInit, geneList, indexInit) => {
    let geneStrand = geneStrandInit;
    let nextGene = nextGeneInit;
    let idx = indexInit;
    while (geneStrand === nextGene.direction) {
      const nextIndex = direction === '+' ? idx + 1 : idx - 1;
      const candidate = safeFasta(nextIndex);
      if (!candidate) break;
      if (Math.abs(seqStart - candidate.start) > 8000) break;

      if (geneStrand === '-' && candidate.direction === '+' && direction === '+') {
        geneList.push(candidate);
      } else if (geneStrand === '+' && candidate.direction === '-' && direction === '-') {
        geneList.push(candidate);
      } else if (geneStrand === candidate.direction) {
        geneList.push(candidate);
      }
      nextGene = candidate;
      idx = nextIndex;
    }
  };

  let geneStrand = strand;
  let geneArray = [];

  // Downstream walk (Python: index - 1 is "down")
  const indexDOWN = index - 1;
  if (indexDOWN >= 0) {
    const downGene = safeFasta(indexDOWN);
    if (downGene) {
      if (strand === '+' && downGene.direction === '-') {
        geneStrand = downGene.direction;
      }
      const downgenes = [downGene];
      getGene(geneStrand, '-', downGene, downgenes, indexDOWN);
      geneArray = downgenes.slice().reverse();
    }
  }

  const currentGene = safeFasta(index);
  if (currentGene) geneArray.push(currentGene);
  const regulatorIndex = geneArray.length - 1;

  geneStrand = strand;

  // Upstream walk (Python: index + 1 is "up")
  const indexUP = index + 1;
  const upGene = safeFasta(indexUP);
  if (upGene) {
    if (strand === '-' && upGene.direction === '+') {
      geneStrand = upGene.direction;
    }
    geneArray.push(upGene);
    getGene(geneStrand, '+', upGene, geneArray, indexUP);
  }

  logger.info(`Operon complete: ${geneArray.length} genes, regulator index: ${regulatorIndex}`);
  return { operon: geneArray, regulatorIndex };
};

export const acc2operon = async (accession) => {
  logger.info(`Starting acc2operon for accession: ${accession}`);

  const metaData = await acc2MetaData(accession);
  if (!metaData) {
    logger.error('Failed to get metadata');
    return null;
  }

  const genome = await NC2genome(metaData.accver);
  if (!genome.length) return null;

  let parsed;
  try {
    parsed = parseGenome(genome, metaData.start, metaData.stop);
  } catch (err) {
    logger.error(`parseGenome failed: ${err.message}`);
    return null;
  }
  const { allGenes, regIndex } = parsed;

  const reg = fasta2MetaData(allGenes[regIndex]);
  const { operon, regulatorIndex } = getOperonWalk(allGenes, regIndex, reg.start, reg.direction);

  return { operon, regIndex: regulatorIndex, genome: metaData.accver };
};

/* PORTING_NOTES
 *
 * 1. Negative-index wrap (getGene): Python's list[-1] silently returns the
 *    last element. Inside the recursive walker the original code does
 *    `index - 1` without bounds checking, so a deep downstream walk could
 *    wrap to the end of the genome — almost always rejected by the 8kb
 *    distance cutoff, but technically a latent bug. We bound explicitly
 *    via safeFasta(); the 8kb cutoff was already doing this work in
 *    practice.
 *
 * 2. parseGenome unbound regIndex: Python raises UnboundLocalError if no
 *    line matched. We throw an explicit Error with a clear message and
 *    acc2operon returns null, mapping cleanly to the Python "Failed to
 *    process accession" path.
 *
 * 3. /tmp/genome.txt round-trip: Python writes then reads the genome from
 *    /tmp. On a Lambda warm container this can return STALE data from a
 *    previous invocation if the eFetch call failed. We do not replicate
 *    that — failed fetch returns []. This is a deliberate divergence
 *    that fixes a real bug.
 *
 * 4. First-CDS-wins: NCBI IPG XML can contain many <CDS> elements; Python
 *    returns the first one and bails. The regex in firstCdsAttributes
 *    matches the first <CDS ...> only.
 *
 * 5. re.compile(start) → new RegExp(start): identical for digit strings,
 *    which is all NCBI ever returns for these coordinate fields.
 */
