import requests
import re
import xml.etree.ElementTree as ET
import json
import io
import logging

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

headers = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.163 Safari/537.36"
}


def acc2MetaData(access_id: str):
    logger.info(f"Fetching metadata for access_id: {access_id}")
    url = f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=protein&id={access_id}&rettype=ipg"
    
    logger.debug(f"Making request to URL: {url}")
    result = requests.get(url)
    result.encoding = "utf-8"

    if result.status_code != 200:
        logger.error(f"Non-200 HTTP response: {result.status_code}. eFetch failed")
        print("non-200 HTTP response. eFetch failed")
        return None

    try:
        logger.debug("Parsing XML response")
        # Use io.StringIO to wrap the response text for iterparse
        xml_file = io.StringIO(result.text)

        # Use a generator to parse the XML incrementally
        context = ET.iterparse(xml_file, events=("start", "end"))
        context = iter(context)

        # Initialize the root element
        _, root = next(context)

        for event, elem in context:
            if event == "end" and elem.tag == "CDS":
                # Found the CDS element
                CDS = elem.attrib
                logger.debug(f"Found CDS element: {CDS}")

                # Process the element
                proteinDict = {
                    "accver": CDS["accver"],
                    "start": CDS["start"],
                    "stop": CDS["stop"],
                    "strand": CDS["strand"],
                }
                logger.info(f"Metadata retrieved successfully: {proteinDict}")

                # Clear the element to free memory
                root.clear()

                return proteinDict

        logger.warning("No CDS element found in XML response")
    except ET.ParseError as e:
        logger.error(f"XML ParseError: {e}")
        print("ParseError:", e)
    except Exception as e:
        logger.error(f"Exception during metadata retrieval: {e}")
        print("Exception:", e)

    return None


def NC2genome(NCacc):
    logger.info(f"Fetching genome for NC accession: {NCacc}")
    url = f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=nuccore&id={NCacc}&rettype=fasta_cds_aa"
    logger.debug(f"Making request to URL: {url}")
    
    response = requests.get(url)

    if response.ok:
        logger.info("Genome data retrieved successfully")
        data = response.text
        logger.debug("Writing genome data to temporary file")
        with open("/tmp/genome.txt", mode="w+") as f:
            f.write(data)
    else:
        logger.error(f"Bad request when fetching genome: {response.status_code}")
        print("bad request")

    logger.debug("Reading genome data from temporary file")
    with open("/tmp/genome.txt", mode="r+") as f:
        genome = f.readlines()
    
    logger.info(f"Genome parsed with {len(genome)} lines")
    return genome


def parseGenome(genome, start, stop):
    logger.info(f"Parsing genome with start {start}, stop {stop}")
    re1 = re.compile(start)
    re2 = re.compile(stop)
    geneIndex = 0
    allGenes = []
    
    for i in genome:
        if i[0] == ">":
            if re1.search(i):
                if re2.search(i):
                    logger.debug(f"Found matching gene at index {geneIndex}")
                    regIndex = geneIndex
            geneIndex += 1
            allGenes.append(i)
    
    logger.info(f"Genome parsed: found {len(allGenes)} genes, regulator at index {regIndex if 'regIndex' in locals() else 'not found'}")
    return allGenes, regIndex


def fasta2MetaData(fasta):
    logger.debug(f"Converting FASTA to metadata: {fasta[:50]}...")
    metaData = {}
    regulator = fasta.split(" [")

    for i in regulator:
        if i[:10] == "locus_tag=":
            metaData["alias"] = i[10:-1]
        elif i[:8] == "protein=":
            metaData["description"] = i[8:-1].replace("'", "")
        elif i[:11] == "protein_id=":
            metaData["link"] = i[11:-1]
        elif i[:9] == "location=":
            if i[9:20] == "complement(":
                metaData["direction"] = "-"
                location = i[20:-2]
                location = location.split("..")
                metaData["start"] = int(re.sub("\D", "", location[0]))
                metaData["stop"] = int(re.sub("\D", "", location[1]))
            else:
                metaData["direction"] = "+"
                location = i[9:-1]
                location = location.split("..")
                metaData["start"] = int(re.sub("\D", "", location[0]))
                metaData["stop"] = int(re.sub("\D", "", location[1]))

    if "link" not in metaData.keys():
        metaData["link"] = ""

    logger.debug(f"FASTA metadata extracted: {metaData}")
    return metaData


def getOperon(allGenes, index, seq_start, strand):
    """
    Rules for inclusion/exclusion of genes from operon:
        - always take immediately adjacent genes
        - if query gene is in same direction as regulator, include it.
        - if query gene is expressed divergently from regulator,
                grab all adjacent genes that are expressed divergently (change strand direction for next genes)
        - if query gene is expressed divergently from a co-transcribed neighbor of the regulaor,
                grab that gene. (it may be another regulator. Important to know).
        - if query gene direction converges with regulator, exclude it.
    """
    logger.info(f"Getting operon for gene at index {index} with start {seq_start} and strand {strand}")

    def getGene(geneStrand, direction, nextGene, geneList, index):
        logger.debug(f"getGene: geneStrand={geneStrand}, direction={direction}, index={index}")
        while geneStrand == nextGene["direction"]:
            if direction == "+":
                nextIndex = index + 1
            elif direction == "-":
                nextIndex = index - 1

            logger.debug(f"Attempting to get gene at index {nextIndex}")
            try:
                nextGene = fasta2MetaData(allGenes[nextIndex])
                logger.debug(f"Next gene: {nextGene}")

                if (
                    abs(seq_start - nextGene["start"]) > 8000
                ):  # added this. break if too far away
                    break

                elif (geneStrand == "-" and nextGene["direction"] == "+" and direction == "+"):
                    logger.debug("Adding gene with special case 1")
                    geneList.append(nextGene)
                elif (geneStrand == "+" and nextGene["direction"] == "-" and direction == "-"):
                    logger.debug("Adding gene with special case 2") 
                    geneList.append(nextGene)
                elif geneStrand == nextGene["direction"]:
                    logger.debug("Adding gene with matching strand")
                    geneList.append(nextGene)
                index = nextIndex
            except Exception as e:
                logger.debug(f"Exception when getting gene at index {nextIndex}: {e}")
                break

    geneStrand = strand
    geneArray = []

    # attempt to get downstream genes, if there are any genes downstream
    logger.debug("Looking for downstream genes")
    try:
        indexDOWN = index - 1
        logger.debug(f"Checking downstream gene at index {indexDOWN}")
        if indexDOWN < 0:
            logger.debug("Index would be negative, no downstream genes")
            raise IndexError("Negative index")
            
        downGene = fasta2MetaData(allGenes[indexDOWN])
        logger.debug(f"Found downstream gene: {downGene}")
        
        # if seq_start > downGene['start']:
        if strand == "+" and downGene["direction"] == "-":
            logger.debug(f"Setting geneStrand from {geneStrand} to {downGene['direction']}")
            geneStrand = downGene["direction"]

        downgenes = [downGene]
        logger.debug(f"Getting more downstream genes from index {indexDOWN}")
        getGene(geneStrand, "-", downGene, downgenes, indexDOWN)
        logger.debug(f"Found {len(downgenes)} downstream genes")

        geneArray = list(reversed(downgenes))
        logger.debug(f"Reversed downstream genes array, length: {len(geneArray)}")
    except Exception as e:
        logger.debug(f"Exception when getting downstream genes: {e}")
        logger.debug("No downstream genes found or exception occurred")
        geneArray = []

    logger.debug(f"Getting current gene at index {index}")
    try:
        current_gene = fasta2MetaData(allGenes[index])
        geneArray.append(current_gene)
        logger.debug(f"Added current gene: {current_gene}")
    except Exception as e:
        logger.error(f"Failed to get current gene at index {index}: {e}")
    
    regulatorIndex = len(geneArray) - 1
    logger.debug(f"Regulator index set to {regulatorIndex}")

    geneStrand = strand

    # attempt to get upstream genes, if there are any genes upstream
    logger.debug("Looking for upstream genes")
    try:
        indexUP = index + 1
        logger.debug(f"Checking upstream gene at index {indexUP}")
        upGene = fasta2MetaData(allGenes[indexUP])
        logger.debug(f"Found upstream gene: {upGene}")
        
        # if seq_start > upGene['start']:
        if strand == "-" and upGene["direction"] == "+":
            logger.debug(f"Setting geneStrand from {geneStrand} to {upGene['direction']}")
            geneStrand = upGene["direction"]

        geneArray.append(upGene)
        logger.debug(f"Getting more upstream genes from index {indexUP}")
        getGene(geneStrand, "+", upGene, geneArray, indexUP)
    except Exception as e:
        logger.debug(f"Exception when getting upstream genes: {e}")
        logger.debug("No upstream genes found or exception occurred")

    logger.info(f"Operon complete: {len(geneArray)} genes, regulator index: {regulatorIndex}")
    return geneArray, regulatorIndex


def acc2operon(accession):
    logger.info(f"Starting acc2operon for accession: {accession}")
    
    logger.debug("Fetching metadata")
    metaData = acc2MetaData(accession)
    if not metaData:
        logger.error("Failed to get metadata")
        return None
    logger.debug(f"Metadata: {metaData}")

    logger.debug(f"Fetching genome for accession: {metaData['accver']}")
    genome = NC2genome(metaData["accver"])
    logger.debug(f"Genome size: {len(genome)} lines")

    logger.debug(f"Parsing genome with start: {metaData['start']}, stop: {metaData['stop']}")
    allGenes, index = parseGenome(genome, metaData["start"], metaData["stop"])
    logger.debug(f"Parsed genome: {len(allGenes)} genes, gene of interest at index {index}")

    logger.debug(f"Getting regulator info at index {index}")
    reg = fasta2MetaData(allGenes[index])
    logger.debug(f"Regulator: {reg}")

    logger.debug(f"Getting operon for index {index}, start {reg['start']}, direction {reg['direction']}")
    operon, regIndex = getOperon(allGenes, index, reg["start"], reg["direction"])
    logger.debug(f"Operon obtained: {len(operon)} genes, regulator at index {regIndex}")

    data = {"operon": operon, "regIndex": regIndex, "genome": metaData["accver"]}
    logger.info("acc2operon completed successfully")
    
    return data


def lambda_handler(event, context):
    logger.info(f"Lambda handler invoked with event: {event}")
    
    try:
        accession_id = event["queryStringParameters"]["id"]
        logger.info(f"Processing accession ID: {accession_id}")
        
        result = acc2operon(accession_id)
        
        if result:
            logger.info("Request processed successfully")
            return {"statusCode": 200, "body": json.dumps(result)}
        else:
            logger.error("Failed to process accession")
            return {"statusCode": 500, "body": json.dumps({"error": "Failed to process accession"})}
            
    except Exception as e:
        logger.error(f"Error in lambda_handler: {e}", exc_info=True)
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}
